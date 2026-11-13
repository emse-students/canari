//! The peer-to-peer signalling relay: a 1:1 call, and a group call up to its mesh cap, go PEER TO
//! PEER and this service only carries the handshake.
//!
//! WHY IT EXISTS (user, 2026-10-16). The production host cannot send UDP to the internet (the
//! School border drops it, measured 2026-10-15), so the SFU's media leg - webrtc-rs speaking TURN
//! over UDP only - can never connect from there. The CLIENTS reach Cloudflare TURN over every
//! transport. So a 1:1 call keeps its media OFF the host entirely: the two browsers negotiate a
//! direct path (host, then server-reflexive, then the Cloudflare relay as the last resort), and
//! this file forwards their `Offer` / `Answer` / `IceCandidate` frames to each other over the
//! WebSocket the host already serves on 443. No `RTCPeerConnection` is opened here, so nothing in
//! this mode touches webrtc-rs or needs a port. See
//! `docs/wiki/infrastructure/realtime-media-feasibility.md` section 8.2 (A).
//!
//! WHAT IT DOES NOT CHANGE. The SDP carries no secret the media keys depend on: each direction's
//! frame key is an MLS export on each client (`frontend/src/lib/utils/callKeys.ts`, label
//! `mls-webrtc-media-v2`, context `<callId>|<sender role>`), so forwarding SDP in clear
//! over the authenticated socket is the same exposure the SFU path already had.
//!
//! THE ROLES. The first peer in the room (the caller, who joins before ringing) is told
//! `initiator: true` and makes the offer; the second is `initiator: false` and is the POLITE side
//! of perfect negotiation, the one that yields on an offer collision. The roles come from arrival
//! order, decided under one lock, so both ends always disagree about who is polite - which is the
//! whole requirement.
//!
//! A NETWORK BLIP IS NOT A HANGUP (2026-10-19, CALL-WIFI). A phone losing Wi-Fi for 6 s ended its
//! call: the socket closed, the seat was freed and the partner was told `PeerLeft`. Now a socket
//! that dies WITHOUT a Close frame leaves its seat ABSENT for a grace (`CALL_P2P_SEAT_GRACE_SEC`),
//! the partner is told `PeerAway`, and the same device takes the seat back with the resume token it
//! received in `Joined`. Only a Close frame (a hangup) or the grace running out frees the seat.
//!
//! THE MESH (WP-GC2, 2026-11-13). A group call is a full mesh of the pairs above: every two PRESENT
//! seats form one pair, with its own initiator (the seat that arrived first) and its own polite
//! side, and every client holds one peer connection per other participant. A room seats at most
//! `max_seats` users, a number chat-delivery-service signs into the room token (4 for an audio
//! group call, 3 for a video one; 2 - the default when the claim is absent - for a 1:1 call).
//! Frames are ADDRESSED: a client names the user it writes to (`to`), and the relay stamps the
//! sender's user id on what it forwards (`from`), so no client can speak as another. A two-seat
//! room still routes an unaddressed frame to the one other party, which is how a client older than
//! the mesh speaks; a larger room refuses one, which no mesh client sends.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use crate::{bump, CallLedger, PeerId};

/// The seats of a room whose token names no `max_seats`: a 1:1 call, as every room was before the
/// mesh, and as every token minted by a chat-delivery-service older than the mesh reads.
pub(crate) const DEFAULT_MAX_SEATS: usize = 2;

/// The most seats a peer-to-peer room may hold, whatever a token says: the owner's mesh cap (D-A,
/// 2026-10-31: 4 in audio, 3 in video). A token above it is refused - past the cap a call goes
/// through a relay, never a larger mesh.
pub(crate) const MAX_MESH_SEATS: usize = 4;

/// One participant of a room: where to write its frames, and its record.
#[derive(Clone)]
pub(crate) struct P2pPeer {
    pub(crate) peer_id: PeerId,
    pub(crate) user_id: String,
    /// The `group_id` its room token was signed for. Every seat must carry the same one.
    pub(crate) group_id: String,
    pub(crate) tx: mpsc::Sender<crate::SignalMessage>,
    pub(crate) ledger: Arc<CallLedger>,
}

/// Why a relayed frame did not reach the partner's socket writer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DropReason {
    /// The partner's bounded queue is full: it is already that many frames behind.
    Full,
    /// The partner's socket task has ended.
    Gone,
}

impl DropReason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            DropReason::Full => "partner queue full",
            DropReason::Gone => "partner socket gone",
        }
    }
}

/// Hands `frame` to a socket writer's queue WITHOUT waiting - the ONLY way this mode sends.
///
/// Every p2p send runs on SOME peer's socket task, and every queue is bounded. Awaiting room in
/// another peer's queue would let a peer that stopped reading freeze this one's reads, keepalive
/// pings and writes; awaiting room in this task's OWN queue would deadlock it outright, since the
/// task that drains it is the one waiting. So it is synchronous by construction, and a frame that
/// does not fit is dropped and returned as a reason for the caller to log.
pub(crate) fn deliver(
    tx: &mpsc::Sender<crate::SignalMessage>,
    frame: crate::SignalMessage,
) -> Result<(), DropReason> {
    tx.try_send(frame).map_err(|e| match e {
        mpsc::error::TrySendError::Full(_) => DropReason::Full,
        mpsc::error::TrySendError::Closed(_) => DropReason::Gone,
    })
}

/// Two present seats told to negotiate: `initiator` arrived first and offers, `polite` answers.
pub(crate) struct Pairing {
    pub(crate) initiator: P2pPeer,
    pub(crate) polite: P2pPeer,
    /// Whether these two USERS had already been paired in this room: keep the peer connection and
    /// restart ICE if needed. `false` = build it from nothing (a first meeting, or a new device).
    pub(crate) resumed: bool,
}

/// What a `Join` did to the room. Decided under the room's lock, acted on after it is released,
/// because sending a frame is async and a lock must never be held across an await.
pub(crate) enum JoinOutcome {
    /// Seated. Each pairing is one pair to announce (none while the newcomer is alone); each away
    /// seat is a participant whose socket is gone and may still resume, named to the newcomer with
    /// `PeerAway` - its pairing waits for that resume.
    Seated {
        /// Devices of the same user that this join replaced (one device per user per call).
        evicted: Vec<P2pPeer>,
        pairings: Vec<Pairing>,
        away: Vec<P2pPeer>,
    },
    /// `max_seats` OTHER users already hold the room. Nothing changed.
    Full { max_seats: usize },
    /// The room is held by a peer whose token names ANOTHER group. Nothing changed.
    OtherGroup,
    /// The token names another seat count than the room was opened with. Nothing changed.
    OtherSeats { room: usize, token: usize },
}

/// Where another seat stands after a resume.
pub(crate) enum OtherSeat {
    /// Held, but its socket is gone too: named with `PeerAway`; the pairing waits for ITS resume.
    Away(P2pPeer),
    /// Present: both are told `PeerReady` again.
    Present(Pairing),
}

/// What a resume did. A seat is resumed IN PLACE, so every pair keeps its initiator.
pub(crate) enum ResumeOutcome {
    /// No seat of this user, in this group, carries that id: it expired, or the call ended.
    Unknown,
    Resumed {
        /// The seat's previous socket when it was still counted present - the server had not yet
        /// noticed that it died. Its record is closed `resumed`; it is told nothing.
        replaced: Option<P2pPeer>,
        others: Vec<OtherSeat>,
        /// Nobody else holds a seat although somebody did: the call is over (the others hung up,
        /// or their seats expired, while this one was away).
        call_over: bool,
    },
}

/// What a departure (a hangup, an expired grace, a lost socket) leaves behind: the user who went,
/// and the PRESENT seats to tell.
pub(crate) struct Departure {
    pub(crate) user_id: String,
    pub(crate) tell: Vec<P2pPeer>,
}

/// Where a frame from one seat goes.
pub(crate) enum Route {
    /// To this present seat.
    To(P2pPeer),
    /// To every other present seat (a microphone state in a mesh: one fact for everyone).
    Everyone(Vec<P2pPeer>),
    /// The addressee holds a seat but is away: expected during a reconnection.
    Away,
    /// Nobody to receive it: alone, or an addressee that holds no seat.
    Nobody,
    /// The sender holds no seat (evicted, or its seat expired): its record already says why.
    NotSeated,
    /// A room of more than two seats received a frame naming no addressee - no mesh client sends
    /// one, and guessing would hand one participant's SDP to another.
    Unaddressed,
}

/// One seat: a participant, and whether its socket is currently alive.
///
/// A seat whose socket died WITHOUT a Close frame is kept, ABSENT, so a network blip does not end
/// the call: the same device may take it back with its resume token. A Close frame is a hangup and
/// frees the seat at once.
struct Seat {
    peer: P2pPeer,
    present: bool,
}

#[derive(Default)]
struct Seats {
    /// At most `max_seats`, of distinct users, in arrival order: in every pair, the seat with the
    /// lower index is the initiator.
    seats: Vec<Seat>,
    /// Set by the first join, from its token; every later token must carry the same.
    max_seats: Option<usize>,
    /// Every pair of USERS that has been paired in this room, the smaller id first.
    paired: HashSet<(String, String)>,
    /// Whether the room ever held two parties present at once.
    paired_once: bool,
}

fn pair_key(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

impl Seats {
    /// Pairs the seat at `idx` with every other PRESENT seat and marks each pair as paired; in each
    /// pair the lower index initiates. Returns the pairings, and the away seats to name.
    fn pair_up(&mut self, idx: usize) -> (Vec<Pairing>, Vec<P2pPeer>) {
        let me = self.seats[idx].peer.clone();
        let mut pairings = Vec::new();
        let mut away = Vec::new();
        for (i, other) in self.seats.iter().enumerate() {
            if i == idx {
                continue;
            }
            if !other.present {
                away.push(other.peer.clone());
                continue;
            }
            let resumed = self
                .paired
                .contains(&pair_key(&me.user_id, &other.peer.user_id));
            let (initiator, polite) = if i < idx {
                (other.peer.clone(), me.clone())
            } else {
                (me.clone(), other.peer.clone())
            };
            pairings.push(Pairing {
                initiator,
                polite,
                resumed,
            });
        }
        for p in &pairings {
            self.paired
                .insert(pair_key(&p.initiator.user_id, &p.polite.user_id));
        }
        if !pairings.is_empty() {
            self.paired_once = true;
        }
        (pairings, away)
    }

    /// Forgets every pair `user` was in: its next device builds every peer connection anew.
    fn forget_pairs_of(&mut self, user: &str) {
        self.paired.retain(|(a, b)| a != user && b != user);
    }

    fn present_others(&self, peer_id: &str) -> Vec<P2pPeer> {
        self.seats
            .iter()
            .filter(|s| s.peer.peer_id != peer_id && s.present)
            .map(|s| s.peer.clone())
            .collect()
    }

    fn cap(&self) -> usize {
        self.max_seats.unwrap_or(DEFAULT_MAX_SEATS)
    }
}

/// A room in peer-to-peer mode: at most `max_seats` seats of distinct users, in arrival order.
#[derive(Default)]
pub(crate) struct P2pRoom {
    inner: Mutex<Seats>,
}

impl P2pRoom {
    /// Admits `peer` into a room of `max_seats`, replacing any device of the same user already in
    /// it (present or away).
    ///
    /// The group, seat-count and capacity checks run BEFORE the eviction, so a refused join leaves
    /// the room exactly as it found it - a user past the cap must not be able to knock a
    /// participant out by trying to enter. The group check comes first: a room id is a bearer
    /// secret only as long as nobody has seen it, and a token for another conversation must not
    /// seat anyone here, not even a device of a user already in the room.
    pub(crate) fn join(&self, peer: P2pPeer, max_seats: usize) -> JoinOutcome {
        let Ok(mut room) = self.inner.lock() else {
            // A poisoned lock means a panic while holding it; refusing is the only answer that
            // cannot put an extra party into a call. The caller logs the refusal.
            return JoinOutcome::Full { max_seats };
        };
        if room.seats.iter().any(|s| s.peer.group_id != peer.group_id) {
            return JoinOutcome::OtherGroup;
        }
        let cap = *room.max_seats.get_or_insert(max_seats);
        if cap != max_seats {
            return JoinOutcome::OtherSeats {
                room: cap,
                token: max_seats,
            };
        }
        let others = room
            .seats
            .iter()
            .filter(|s| s.peer.user_id != peer.user_id)
            .count();
        // `others` OTHER users plus this one must fit: a room of `cap` holds `cap - 1` others.
        if others + 1 > cap {
            return JoinOutcome::Full { max_seats: cap };
        }
        let mut evicted = Vec::new();
        room.seats.retain(|s| {
            if s.peer.user_id == peer.user_id {
                evicted.push(s.peer.clone());
                false
            } else {
                true
            }
        });
        if !evicted.is_empty() {
            room.forget_pairs_of(&peer.user_id);
        }
        room.seats.push(Seat {
            peer,
            present: true,
        });
        let idx = room.seats.len() - 1;
        let (pairings, away) = room.pair_up(idx);
        JoinOutcome::Seated {
            evicted,
            pairings,
            away,
        }
    }

    /// Gives the seat `seat_id` to `peer` - the same user's new socket - keeping its PLACE, so
    /// every pair it is in keeps its initiator. Refused (`Unknown`) unless that seat exists for
    /// the same user and group.
    pub(crate) fn resume(&self, seat_id: &str, peer: P2pPeer) -> ResumeOutcome {
        let Ok(mut room) = self.inner.lock() else {
            return ResumeOutcome::Unknown;
        };
        let Some(idx) = room.seats.iter().position(|s| {
            s.peer.peer_id == seat_id
                && s.peer.user_id == peer.user_id
                && s.peer.group_id == peer.group_id
        }) else {
            return ResumeOutcome::Unknown;
        };
        let old = std::mem::replace(
            &mut room.seats[idx],
            Seat {
                peer,
                present: true,
            },
        );
        let replaced = old.present.then_some(old.peer);
        let call_over = room.seats.len() == 1 && room.paired_once;
        let (pairings, away) = room.pair_up(idx);
        let mut others: Vec<OtherSeat> = away.into_iter().map(OtherSeat::Away).collect();
        others.extend(pairings.into_iter().map(OtherSeat::Present));
        ResumeOutcome::Resumed {
            replaced,
            others,
            call_over,
        }
    }

    /// Marks `peer_id`'s seat ABSENT: its socket died without a Close frame. Returns `None` when
    /// that socket no longer holds a seat (replaced by a sibling or by its own resume - already
    /// explained), else the present others, to be told `PeerAway`.
    pub(crate) fn mark_absent(&self, peer_id: &str) -> Option<Departure> {
        let mut room = self.inner.lock().ok()?;
        let seat = room
            .seats
            .iter_mut()
            .find(|s| s.peer.peer_id == peer_id && s.present)?;
        seat.present = false;
        let user_id = seat.peer.user_id.clone();
        Some(Departure {
            user_id,
            tell: room.present_others(peer_id),
        })
    }

    /// Frees `peer_id`'s seat IF it is still absent: the grace ran out and nobody resumed it.
    /// Returns `None` when there is nothing to expire (resumed, or already gone), else the present
    /// others, to be told `PeerLeft`.
    pub(crate) fn expire(&self, peer_id: &str) -> Option<Departure> {
        let mut room = self.inner.lock().ok()?;
        let idx = room
            .seats
            .iter()
            .position(|s| s.peer.peer_id == peer_id && !s.present)?;
        let gone = room.seats.remove(idx);
        room.forget_pairs_of(&gone.peer.user_id);
        Some(Departure {
            user_id: gone.peer.user_id,
            tell: room.present_others(peer_id),
        })
    }

    /// Removes `peer_id` (a hangup) and returns the present others, if `peer_id` was actually in
    /// the room. An evicted sibling's socket closing later finds itself already gone and must not
    /// tell anyone that its user left. An away participant learns it on resume (`call_over`, or
    /// pairings that no longer include the one who left).
    pub(crate) fn leave(&self, peer_id: &str) -> Option<Departure> {
        let mut room = self.inner.lock().ok()?;
        let idx = room.seats.iter().position(|s| s.peer.peer_id == peer_id)?;
        let gone = room.seats.remove(idx);
        room.forget_pairs_of(&gone.peer.user_id);
        Some(Departure {
            user_id: gone.peer.user_id,
            tell: room.present_others(peer_id),
        })
    }

    /// Where a frame from `peer_id` goes. `to` is the addressee's user id. `None` routes to the one
    /// other party of a two-seat room (the 1:1 wire, which names nobody); in a larger room it is
    /// `Unaddressed`, unless `broadcast`, which sends it to every other present seat.
    pub(crate) fn route(&self, peer_id: &str, to: Option<&str>, broadcast: bool) -> Route {
        let Ok(room) = self.inner.lock() else {
            return Route::Nobody;
        };
        let Some(me) = room.seats.iter().find(|s| s.peer.peer_id == peer_id) else {
            return Route::NotSeated;
        };
        let mesh = room.cap() > DEFAULT_MAX_SEATS;
        let target = match to {
            Some(user) => room
                .seats
                .iter()
                .find(|s| s.peer.user_id == user && s.peer.user_id != me.peer.user_id),
            None if !mesh => room
                .seats
                .iter()
                .find(|s| s.peer.user_id != me.peer.user_id),
            None if broadcast => {
                let all = room.present_others(peer_id);
                return if all.is_empty() {
                    Route::Nobody
                } else {
                    Route::Everyone(all)
                };
            }
            None => return Route::Unaddressed,
        };
        match target {
            Some(s) if s.present => Route::To(s.peer.clone()),
            Some(_) => Route::Away,
            None => Route::Nobody,
        }
    }

    /// Whether `peer_id` still holds a seat (present or away).
    #[cfg(test)]
    pub(crate) fn contains(&self, peer_id: &str) -> bool {
        self.inner
            .lock()
            .map(|r| r.seats.iter().any(|s| s.peer.peer_id == peer_id))
            .unwrap_or(false)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.inner
            .lock()
            .map(|r| r.seats.is_empty())
            .unwrap_or(true)
    }
}

/// The frames a peer may relay, named for the ledger.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RelayedKind {
    Offer,
    Answer,
    Ice,
    /// The polite side asking the initiator to restart ICE. Rare (a few per lost path at most), so
    /// it has no counter: its relay line is the record.
    IceRestartRequest,
    /// The sender's operating system took or gave back its microphone. Rare (one per background
    /// transition), so it has no counter either: its relay line is the record.
    MicSuspended,
}

/// Counts a frame on both ledgers: received from the sender, handed to the partner. Kept in one
/// place so the two records of one call can never count the same frame differently.
pub(crate) fn count_relayed(kind: RelayedKind, from: &CallLedger, to: &CallLedger) {
    match kind {
        RelayedKind::Offer => {
            bump(&from.offers_in);
            bump(&to.offers_out);
        }
        RelayedKind::Answer => {
            bump(&from.answers_in);
            bump(&to.answers_out);
        }
        RelayedKind::Ice => {
            bump(&from.ice_in);
            bump(&to.ice_out);
        }
        RelayedKind::IceRestartRequest | RelayedKind::MicSuspended => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{count, RoomMode};

    fn peer(user: &str, device: &str) -> (P2pPeer, mpsc::Receiver<crate::SignalMessage>) {
        peer_in(user, device, "group-1", 8)
    }

    fn peer_in(
        user: &str,
        device: &str,
        group: &str,
        capacity: usize,
    ) -> (P2pPeer, mpsc::Receiver<crate::SignalMessage>) {
        let (tx, rx) = mpsc::channel(capacity);
        let peer_id = format!("{user}:{device}");
        (
            P2pPeer {
                peer_id: peer_id.clone(),
                user_id: user.to_string(),
                group_id: group.to_string(),
                tx,
                ledger: Arc::new(CallLedger::new("room-1".into(), peer_id, RoomMode::P2p)),
            },
            rx,
        )
    }

    /// A 1:1 join: the room of two every token without `max_seats` opens.
    fn join2(room: &P2pRoom, p: P2pPeer) -> JoinOutcome {
        room.join(p, DEFAULT_MAX_SEATS)
    }

    /// The pairings of a `Seated` join as `(initiator, polite, resumed)` peer ids.
    fn pairs(outcome: &JoinOutcome) -> Vec<(String, String, bool)> {
        match outcome {
            JoinOutcome::Seated { pairings, .. } => pairings
                .iter()
                .map(|p| {
                    (
                        p.initiator.peer_id.clone(),
                        p.polite.peer_id.clone(),
                        p.resumed,
                    )
                })
                .collect(),
            _ => panic!("expected a seat"),
        }
    }

    fn routed_to(route: Route) -> Option<String> {
        match route {
            Route::To(p) => Some(p.peer_id),
            _ => None,
        }
    }

    #[test]
    fn the_first_peer_waits_and_the_second_pairs_with_the_first_as_initiator() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        let first = join2(&room, a);
        assert!(pairs(&first).is_empty());
        let second = join2(&room, b);
        assert_eq!(
            pairs(&second),
            vec![("alice:pc".into(), "bob:phone".into(), false)]
        );
        assert_eq!(
            routed_to(room.route("alice:pc", None, false)).as_deref(),
            Some("bob:phone")
        );
        assert_eq!(
            routed_to(room.route("bob:phone", None, false)).as_deref(),
            Some("alice:pc")
        );
    }

    /// A 1:1 call has no third seat, and a refused join must not evict anybody on the way out.
    #[test]
    fn a_third_user_is_refused_from_a_two_seat_room_and_the_room_is_unchanged() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        let (c, _rc) = peer("carol", "pc");
        join2(&room, a);
        join2(&room, b);
        assert!(matches!(
            join2(&room, c),
            JoinOutcome::Full { max_seats: 2 }
        ));
        assert!(room.contains("alice:pc"));
        assert!(room.contains("bob:phone"));
        assert!(!room.contains("carol:pc"));
    }

    /// One device per user: the callee answering on a second device replaces the first, and the
    /// caller is re-paired with the newcomer from nothing (it stays the initiator, having arrived
    /// first).
    #[test]
    fn a_second_device_of_the_same_user_replaces_the_first() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b1, _rb1) = peer("bob", "phone");
        let (b2, _rb2) = peer("bob", "tablet");
        join2(&room, a);
        join2(&room, b1);
        let outcome = join2(&room, b2);
        assert_eq!(
            pairs(&outcome),
            vec![("alice:pc".into(), "bob:tablet".into(), false)]
        );
        match outcome {
            JoinOutcome::Seated { evicted, .. } => {
                assert_eq!(evicted.len(), 1);
                assert_eq!(evicted[0].peer_id, "bob:phone");
            }
            _ => panic!("the replacing device must be seated"),
        }
        assert!(!room.contains("bob:phone"));
        assert_eq!(
            routed_to(room.route("alice:pc", None, false)).as_deref(),
            Some("bob:tablet")
        );
        // The evicted device's frames go nowhere: it is no longer in the room.
        assert!(matches!(
            room.route("bob:phone", None, false),
            Route::NotSeated
        ));
    }

    /// A token for another conversation seats nobody: not a stranger in an empty seat, and not a
    /// second device of the user already there - either would receive the candidates.
    #[test]
    fn a_token_for_another_group_is_refused_and_the_room_is_unchanged() {
        let room = P2pRoom::default();
        let (a, _ra) = peer_in("alice", "pc", "group-1", 8);
        let (mallory, _rm) = peer_in("mallory", "pc", "group-2", 8);
        let (alice_elsewhere, _rx) = peer_in("alice", "phone", "group-2", 8);
        join2(&room, a);
        assert!(matches!(join2(&room, mallory), JoinOutcome::OtherGroup));
        assert!(matches!(
            join2(&room, alice_elsewhere),
            JoinOutcome::OtherGroup
        ));
        assert!(room.contains("alice:pc"));
        assert!(!room.contains("mallory:pc"));
        assert!(!room.contains("alice:phone"));
        assert!(matches!(room.route("alice:pc", None, false), Route::Nobody));
    }

    /// The relay never waits on the partner: a full queue returns at once with a reason, where a
    /// `send().await` would park the sender's socket task until the partner drained.
    #[test]
    fn delivery_to_a_full_queue_drops_at_once_and_says_why() {
        let (b, mut rb) = peer_in("bob", "phone", "group-1", 1);
        let left = || crate::SignalMessage::PeerLeft { peer: None };
        assert_eq!(deliver(&b.tx, left()), Ok(()));
        assert_eq!(deliver(&b.tx, left()), Err(DropReason::Full));
        assert!(rb.try_recv().is_ok());
        drop(rb);
        assert_eq!(deliver(&b.tx, left()), Err(DropReason::Gone));
    }

    #[test]
    fn leaving_names_the_peers_left_behind_once() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        join2(&room, a);
        join2(&room, b);
        let gone = room.leave("bob:phone").unwrap();
        assert_eq!(gone.user_id, "bob");
        assert_eq!(gone.tell.len(), 1);
        assert_eq!(gone.tell[0].peer_id, "alice:pc");
        // A second leave of the same peer (an evicted socket closing late) reports nothing.
        assert!(room.leave("bob:phone").is_none());
        assert!(room.leave("alice:pc").unwrap().tell.is_empty());
        assert!(room.is_empty());
    }

    /// A socket dying without a Close frame keeps its seat: the partner is named (to be told
    /// `PeerAway`), frames for the away seat have nowhere to go, and the room is not empty.
    #[test]
    fn a_lost_socket_leaves_its_seat_away_and_the_partner_is_named() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        join2(&room, a);
        join2(&room, b);
        let away = room.mark_absent("bob:phone").unwrap();
        assert_eq!(away.user_id, "bob");
        assert_eq!(away.tell[0].peer_id, "alice:pc");
        assert!(room.contains("bob:phone"));
        assert!(matches!(room.route("alice:pc", None, false), Route::Away));
        assert!(!room.is_empty());
        // Already away: a second report is nothing new.
        assert!(room.mark_absent("bob:phone").is_none());
    }

    /// The same device takes its seat back IN PLACE: the caller stays the initiator, both are
    /// paired again with `resumed`, and the grace that was running finds nothing to expire.
    #[test]
    fn a_resume_takes_the_seat_back_in_place_and_cancels_the_expiry() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        join2(&room, a);
        join2(&room, b);
        room.mark_absent("alice:pc");

        let (a2, _ra2) = peer("alice", "pc-again");
        match room.resume("alice:pc", a2) {
            ResumeOutcome::Resumed {
                replaced: None,
                others,
                call_over: false,
            } => match others.as_slice() {
                [OtherSeat::Present(p)] => {
                    assert_eq!(p.initiator.peer_id, "alice:pc-again");
                    assert_eq!(p.polite.peer_id, "bob:phone");
                    assert!(p.resumed);
                }
                _ => panic!("bob must be paired again"),
            },
            _ => panic!("the caller must resume"),
        }
        assert!(room.expire("alice:pc").is_none());
        assert_eq!(
            routed_to(room.route("bob:phone", None, false)).as_deref(),
            Some("alice:pc-again")
        );
    }

    /// The server may not have noticed the old socket died: the resume replaces a seat still
    /// counted present, and hands the old holder back so its record can be closed.
    #[test]
    fn a_resume_before_the_server_noticed_the_loss_replaces_the_live_seat() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        join2(&room, a);
        join2(&room, b);
        let (b2, _rb2) = peer("bob", "phone-again");
        match room.resume("bob:phone", b2) {
            ResumeOutcome::Resumed {
                replaced: Some(old),
                others,
                ..
            } => {
                assert_eq!(old.peer_id, "bob:phone");
                assert!(matches!(
                    others.as_slice(),
                    [OtherSeat::Present(Pairing { resumed: true, .. })]
                ));
            }
            _ => panic!("the live seat must be replaced"),
        }
        // The old socket closing later finds no seat: nobody is told anything.
        assert!(room.mark_absent("bob:phone").is_none());
        assert!(room.leave("bob:phone").is_none());
    }

    /// A seat id is not a bearer secret on its own: another user, another group or an unknown id
    /// resumes nothing, and the room is unchanged.
    #[test]
    fn a_resume_of_another_users_seat_or_an_unknown_one_is_refused() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        join2(&room, a);
        room.mark_absent("alice:pc");
        let (mallory, _rm) = peer("mallory", "pc");
        assert!(matches!(
            room.resume("alice:pc", mallory),
            ResumeOutcome::Unknown
        ));
        let (alice_other_group, _rx) = peer_in("alice", "phone", "group-2", 8);
        assert!(matches!(
            room.resume("alice:pc", alice_other_group),
            ResumeOutcome::Unknown
        ));
        let (a2, _ra2) = peer("alice", "phone");
        assert!(matches!(
            room.resume("alice:nope", a2),
            ResumeOutcome::Unknown
        ));
        assert!(room.contains("alice:pc"));
    }

    /// The grace ran out: the seat is freed and the present partner is named, to be told the call
    /// is over. A later resume of that seat is refused.
    #[test]
    fn an_expired_seat_is_freed_and_cannot_be_resumed() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        join2(&room, a);
        join2(&room, b);
        room.mark_absent("bob:phone");
        let gone = room.expire("bob:phone").unwrap();
        assert_eq!(gone.tell[0].peer_id, "alice:pc");
        assert!(!room.contains("bob:phone"));
        let (b2, _rb2) = peer("bob", "phone-again");
        assert!(matches!(
            room.resume("bob:phone", b2),
            ResumeOutcome::Unknown
        ));
    }

    /// The partner hung up while this seat was away: the resume says the call is over.
    #[test]
    fn resuming_after_the_partner_hung_up_finds_the_call_over() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        join2(&room, a);
        join2(&room, b);
        room.mark_absent("bob:phone");
        // Alice's Close frame: nobody present to tell.
        assert!(room.leave("alice:pc").unwrap().tell.is_empty());
        let (b2, _rb2) = peer("bob", "phone-again");
        assert!(matches!(
            room.resume("bob:phone", b2),
            ResumeOutcome::Resumed {
                call_over: true,
                ..
            }
        ));
    }

    /// The caller lost its socket while ringing and the callee answered meanwhile: the callee is
    /// told the caller is away, and the caller's resume is a FIRST pairing - no peer connection to
    /// keep.
    #[test]
    fn a_callee_arriving_while_the_caller_is_away_pairs_on_the_callers_resume() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        join2(&room, a);
        room.mark_absent("alice:pc");
        let (b, _rb) = peer("bob", "phone");
        match join2(&room, b) {
            JoinOutcome::Seated { pairings, away, .. } => {
                assert!(pairings.is_empty());
                assert_eq!(away[0].peer_id, "alice:pc");
            }
            _ => panic!("bob must be seated"),
        }
        let (a2, _ra2) = peer("alice", "pc-again");
        assert!(matches!(
            room.resume("alice:pc", a2),
            ResumeOutcome::Resumed {
                call_over: false,
                ref others,
                ..
            } if matches!(others.as_slice(), [OtherSeat::Present(Pairing { resumed: false, .. })])
        ));
    }

    #[test]
    fn a_lone_peer_has_no_partner() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        join2(&room, a);
        assert!(matches!(room.route("alice:pc", None, false), Route::Nobody));
    }

    #[test]
    fn a_relayed_frame_is_counted_on_both_records() {
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        count_relayed(RelayedKind::Offer, &a.ledger, &b.ledger);
        count_relayed(RelayedKind::Answer, &b.ledger, &a.ledger);
        count_relayed(RelayedKind::Ice, &a.ledger, &b.ledger);
        count_relayed(RelayedKind::Ice, &a.ledger, &b.ledger);
        assert_eq!(count(&a.ledger.offers_in), 1);
        assert_eq!(count(&b.ledger.offers_out), 1);
        assert_eq!(count(&b.ledger.answers_in), 1);
        assert_eq!(count(&a.ledger.answers_out), 1);
        assert_eq!(count(&a.ledger.ice_in), 2);
        assert_eq!(count(&b.ledger.ice_out), 2);
    }

    // ---- The mesh (WP-GC2) ----

    /// Every newcomer is paired with EVERY present seat, and in every pair the one that arrived
    /// first initiates - so each pair has exactly one offerer, and the roles never depend on who
    /// speaks first.
    #[test]
    fn a_mesh_pairs_each_newcomer_with_every_present_seat_the_earlier_one_initiating() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        let (c, _rc) = peer("carol", "pc");
        let (d, _rd) = peer("dave", "pc");
        assert!(pairs(&room.join(a, 4)).is_empty());
        assert_eq!(
            pairs(&room.join(b, 4)),
            vec![("alice:pc".into(), "bob:phone".into(), false)]
        );
        assert_eq!(
            pairs(&room.join(c, 4)),
            vec![
                ("alice:pc".into(), "carol:pc".into(), false),
                ("bob:phone".into(), "carol:pc".into(), false),
            ]
        );
        assert_eq!(pairs(&room.join(d, 4)).len(), 3);
    }

    /// The cap is the token's, enforced here: the fifth user of an audio room (4) and the fourth of
    /// a video room (3) are refused, and nobody already seated is touched.
    #[test]
    fn a_mesh_refuses_the_user_past_its_cap_and_is_unchanged() {
        for cap in [3usize, 4] {
            let room = P2pRoom::default();
            let users: Vec<_> = (0..cap).map(|i| peer(&format!("u{i}"), "pc")).collect();
            for (p, _) in &users {
                assert!(matches!(
                    room.join(p.clone(), cap),
                    JoinOutcome::Seated { .. }
                ));
            }
            let (late, _rl) = peer("late", "pc");
            assert!(matches!(
                room.join(late, cap),
                JoinOutcome::Full { max_seats } if max_seats == cap
            ));
            for (p, _) in &users {
                assert!(room.contains(&p.peer_id));
            }
            // A seated user's second device still replaces its first, even at the cap.
            let (again, _ra) = peer("u0", "tablet");
            assert!(matches!(room.join(again, cap), JoinOutcome::Seated { .. }));
        }
    }

    /// A room is opened with ONE seat count: a token naming another (a client holding a token of
    /// an older ring, a forged count) is refused before anything changes.
    #[test]
    fn a_token_naming_another_seat_count_is_refused() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        room.join(a, 4);
        assert!(matches!(
            room.join(b, 2),
            JoinOutcome::OtherSeats { room: 4, token: 2 }
        ));
        assert!(!room.contains("bob:phone"));
    }

    /// Frames are addressed in a mesh: each goes to the user it names, never to a guess; an
    /// unaddressed one is refused, except a broadcast (the microphone state), which goes to every
    /// other present seat.
    #[test]
    fn a_mesh_routes_by_addressee_and_refuses_an_unaddressed_frame() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        let (c, _rc) = peer("carol", "pc");
        room.join(a, 4);
        room.join(b, 4);
        room.join(c, 4);
        assert_eq!(
            routed_to(room.route("alice:pc", Some("carol"), false)).as_deref(),
            Some("carol:pc")
        );
        assert_eq!(
            routed_to(room.route("carol:pc", Some("bob"), false)).as_deref(),
            Some("bob:phone")
        );
        assert!(matches!(
            room.route("alice:pc", None, false),
            Route::Unaddressed
        ));
        match room.route("alice:pc", None, true) {
            Route::Everyone(all) => {
                let ids: Vec<_> = all.iter().map(|p| p.peer_id.as_str()).collect();
                assert_eq!(ids, vec!["bob:phone", "carol:pc"]);
            }
            _ => panic!("a broadcast reaches every other seat"),
        }
        // Nobody can address themselves, nor a user who holds no seat.
        assert!(matches!(
            room.route("alice:pc", Some("alice"), false),
            Route::Nobody
        ));
        assert!(matches!(
            room.route("alice:pc", Some("mallory"), false),
            Route::Nobody
        ));
        room.mark_absent("bob:phone");
        assert!(matches!(
            room.route("alice:pc", Some("bob"), false),
            Route::Away
        ));
    }

    /// A two-seat room still routes a frame that names its addressee - a new client in a 1:1 call
    /// may address, an old one does not, and both reach the other party.
    #[test]
    fn a_two_seat_room_routes_both_an_addressed_and_an_unaddressed_frame() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        join2(&room, a);
        join2(&room, b);
        assert_eq!(
            routed_to(room.route("alice:pc", Some("bob"), false)).as_deref(),
            Some("bob:phone")
        );
        assert_eq!(
            routed_to(room.route("alice:pc", None, true)).as_deref(),
            Some("bob:phone")
        );
    }

    /// One participant leaving a mesh is not the end of the call: the others are told who left and
    /// stay paired with each other; a later newcomer is a FIRST pairing with everyone.
    #[test]
    fn a_mesh_departure_names_the_user_to_everyone_left_and_the_call_goes_on() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        let (c, _rc) = peer("carol", "pc");
        room.join(a, 4);
        room.join(b, 4);
        room.join(c, 4);
        let gone = room.leave("bob:phone").unwrap();
        assert_eq!(gone.user_id, "bob");
        let told: Vec<_> = gone.tell.iter().map(|p| p.peer_id.as_str()).collect();
        assert_eq!(told, vec!["alice:pc", "carol:pc"]);
        assert_eq!(
            routed_to(room.route("alice:pc", Some("carol"), false)).as_deref(),
            Some("carol:pc")
        );
        // Bob comes back on a fresh join: every pair of his is new again.
        let (b2, _rb2) = peer("bob", "tablet");
        assert_eq!(
            pairs(&room.join(b2, 4)),
            vec![
                ("alice:pc".into(), "bob:tablet".into(), false),
                ("carol:pc".into(), "bob:tablet".into(), false),
            ]
        );
    }

    /// A resume in a mesh re-pairs with every present seat (keeping the peer connections it had)
    /// and names every away one, each pair keeping its initiator.
    #[test]
    fn a_mesh_resume_re_pairs_with_the_present_and_names_the_away() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        let (c, _rc) = peer("carol", "pc");
        room.join(a, 4);
        room.join(b, 4);
        room.join(c, 4);
        room.mark_absent("bob:phone");
        room.mark_absent("carol:pc");
        let (b2, _rb2) = peer("bob", "phone-again");
        match room.resume("bob:phone", b2) {
            ResumeOutcome::Resumed {
                others, call_over, ..
            } => {
                assert!(!call_over);
                assert_eq!(others.len(), 2);
                let mut present = 0;
                let mut away = 0;
                for o in &others {
                    match o {
                        OtherSeat::Present(p) => {
                            present += 1;
                            assert_eq!(p.initiator.peer_id, "alice:pc");
                            assert_eq!(p.polite.peer_id, "bob:phone-again");
                            assert!(p.resumed);
                        }
                        OtherSeat::Away(p) => {
                            away += 1;
                            assert_eq!(p.peer_id, "carol:pc");
                        }
                    }
                }
                assert_eq!((present, away), (1, 1));
            }
            ResumeOutcome::Unknown => panic!("bob's seat must resume"),
        }
    }
}
