//! The two-person signalling relay: a 1:1 call goes PEER TO PEER and this service only carries
//! the handshake.
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
//! WHAT IT DOES NOT CHANGE. The SDP carries no secret the media key depends on: the frame key is
//! `exportSecret(groupId, 'mls-webrtc-media', callId)` on each client, so forwarding SDP in clear
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

use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use crate::{bump, CallLedger, PeerId};

/// One participant of a two-person room: where to write its frames, and its record.
#[derive(Clone)]
pub(crate) struct P2pPeer {
    pub(crate) peer_id: PeerId,
    pub(crate) user_id: String,
    /// The `group_id` its room token was signed for. Both seats must carry the same one.
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

/// What a `Join` did to the room. Decided under the room's lock, acted on after it is released,
/// because sending a frame is async and a lock must never be held across an await.
pub(crate) enum JoinOutcome {
    /// The room holds only this peer: it waits for the other party.
    Waiting {
        /// Devices of the same user that this join replaced (one device per user per call).
        evicted: Vec<P2pPeer>,
    },
    /// The room now holds two PRESENT peers. `initiator` is the one that was there first.
    Paired {
        initiator: P2pPeer,
        evicted: Vec<P2pPeer>,
    },
    /// The other seat is held, but its socket is gone and it may still resume (see
    /// [`P2pRoom::mark_absent`]). The newcomer is told `PeerAway`; the pairing happens on resume.
    PartnerAway { evicted: Vec<P2pPeer> },
    /// Two OTHER users already hold the room; a 1:1 call has no third seat. Nothing changed.
    Full,
    /// The room is held by a peer whose token names ANOTHER group. Nothing changed.
    OtherGroup,
}

/// Where the OTHER seat stands after a resume.
pub(crate) enum PartnerState {
    /// Nobody else holds a seat. `was_paired`: somebody did, so the call is over (the other
    /// party hung up, or its own seat expired, while this one was away).
    Alone { was_paired: bool },
    /// The other seat is held but away too: the pairing waits for ITS resume.
    Away,
    /// The other party is present: both are told `PeerReady` again.
    Present {
        partner: P2pPeer,
        /// Whether the resumed seat is the room's first, so the one that offers.
        i_am_initiator: bool,
        /// Whether the two had been paired before. `false` when the room never held both at once
        /// (the caller lost its socket while ringing and the callee arrived meanwhile): there is
        /// no peer connection to keep, so both build one from nothing.
        resumed: bool,
    },
}

/// What a resume did. A seat is resumed IN PLACE, so the initiator stays the initiator.
pub(crate) enum ResumeOutcome {
    /// No seat of this user, in this group, carries that id: it expired, or the call ended.
    Unknown,
    Resumed {
        /// The seat's previous socket when it was still counted present - the server had not yet
        /// noticed that it died. Its record is closed `resumed`; it is told nothing.
        replaced: Option<P2pPeer>,
        partner: PartnerState,
    },
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
    /// At most two, of two distinct users, in arrival order: `seats[0]` is the initiator.
    seats: Vec<Seat>,
    /// Whether the room ever held both parties present at once.
    paired_once: bool,
}

/// A room in peer-to-peer mode: at most two seats of two distinct users, in arrival order.
#[derive(Default)]
pub(crate) struct P2pRoom {
    inner: Mutex<Seats>,
}

impl P2pRoom {
    /// Admits `peer`, replacing any device of the same user already in the room (present or away).
    ///
    /// The group and capacity checks run BEFORE the eviction, so a refused join leaves the room
    /// exactly as it found it - a third user must not be able to knock a participant out by trying
    /// to enter. The group check comes first: a room id is a bearer secret only as long as nobody
    /// has seen it, and a token for another conversation must not seat anyone here, not even a
    /// device of a user already in the room.
    pub(crate) fn join(&self, peer: P2pPeer) -> JoinOutcome {
        let Ok(mut room) = self.inner.lock() else {
            // A poisoned lock means a panic while holding it; refusing is the only answer that
            // cannot put a third party into a call. The caller logs the refusal.
            return JoinOutcome::Full;
        };
        if room.seats.iter().any(|s| s.peer.group_id != peer.group_id) {
            return JoinOutcome::OtherGroup;
        }
        let others = room
            .seats
            .iter()
            .filter(|s| s.peer.user_id != peer.user_id)
            .count();
        if others >= 2 {
            return JoinOutcome::Full;
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
        room.seats.push(Seat {
            peer,
            present: true,
        });
        if room.seats.len() < 2 {
            return JoinOutcome::Waiting { evicted };
        }
        if room.seats[0].present {
            room.paired_once = true;
            JoinOutcome::Paired {
                initiator: room.seats[0].peer.clone(),
                evicted,
            }
        } else {
            JoinOutcome::PartnerAway { evicted }
        }
    }

    /// Gives the seat `seat_id` to `peer` - the same user's new socket - keeping its PLACE, so its
    /// role is unchanged. Refused (`Unknown`) unless that seat exists for the same user and group.
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
        let partner = match room.seats.iter().enumerate().find(|(i, _)| *i != idx) {
            None => PartnerState::Alone {
                was_paired: room.paired_once,
            },
            Some((_, other)) if !other.present => PartnerState::Away,
            Some((_, other)) => {
                let partner = other.peer.clone();
                let resumed = room.paired_once;
                room.paired_once = true;
                PartnerState::Present {
                    partner,
                    i_am_initiator: idx == 0,
                    resumed,
                }
            }
        };
        ResumeOutcome::Resumed { replaced, partner }
    }

    /// Marks `peer_id`'s seat ABSENT: its socket died without a Close frame. Returns `None` when
    /// that socket no longer holds a seat (replaced by a sibling or by its own resume - already
    /// explained), else the other party if it is present, to be told `PeerAway`.
    pub(crate) fn mark_absent(&self, peer_id: &str) -> Option<Option<P2pPeer>> {
        let mut room = self.inner.lock().ok()?;
        let seat = room
            .seats
            .iter_mut()
            .find(|s| s.peer.peer_id == peer_id && s.present)?;
        seat.present = false;
        Some(
            room.seats
                .iter()
                .find(|s| s.peer.peer_id != peer_id && s.present)
                .map(|s| s.peer.clone()),
        )
    }

    /// Frees `peer_id`'s seat IF it is still absent: the grace ran out and nobody resumed it.
    /// Returns `None` when there is nothing to expire (resumed, or already gone), else the other
    /// party if it is present, to be told `PeerLeft`.
    pub(crate) fn expire(&self, peer_id: &str) -> Option<Option<P2pPeer>> {
        let mut room = self.inner.lock().ok()?;
        let idx = room
            .seats
            .iter()
            .position(|s| s.peer.peer_id == peer_id && !s.present)?;
        room.seats.remove(idx);
        Some(
            room.seats
                .iter()
                .find(|s| s.present)
                .map(|s| s.peer.clone()),
        )
    }

    /// Removes `peer_id` (a hangup) and returns the peer left behind, if there is one, it is
    /// present, and `peer_id` was actually in the room. An evicted sibling's socket closing later
    /// finds itself already gone and must not tell the remaining peer that its partner left. A
    /// partner who is away learns it on resume (`PartnerState::Alone { was_paired: true }`).
    pub(crate) fn leave(&self, peer_id: &str) -> Option<P2pPeer> {
        let mut room = self.inner.lock().ok()?;
        let before = room.seats.len();
        room.seats.retain(|s| s.peer.peer_id != peer_id);
        if room.seats.len() == before {
            return None;
        }
        room.seats
            .first()
            .filter(|s| s.present)
            .map(|s| s.peer.clone())
    }

    /// The PRESENT peer a frame from `peer_id` is addressed to. `None` when the sender is not in
    /// the room (evicted), is alone in it, or its partner is away.
    pub(crate) fn partner_of(&self, peer_id: &str) -> Option<P2pPeer> {
        let room = self.inner.lock().ok()?;
        if !room.seats.iter().any(|s| s.peer.peer_id == peer_id) {
            return None;
        }
        room.seats
            .iter()
            .find(|s| s.peer.peer_id != peer_id && s.present)
            .map(|s| s.peer.clone())
    }

    /// Whether `peer_id`'s partner holds a seat but is away: a frame for it has nowhere to go
    /// for now, which is expected during a reconnection.
    pub(crate) fn partner_is_away(&self, peer_id: &str) -> bool {
        self.inner
            .lock()
            .map(|r| {
                r.seats
                    .iter()
                    .any(|s| s.peer.peer_id != peer_id && !s.present)
            })
            .unwrap_or(false)
    }

    /// Whether `peer_id` still holds a seat (present or away).
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

/// The three frames a peer may relay, named for the ledger.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RelayedKind {
    Offer,
    Answer,
    Ice,
    /// The polite side asking the initiator to restart ICE. Rare (a few per lost path at most), so
    /// it has no counter: its relay line is the record.
    IceRestartRequest,
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
        RelayedKind::IceRestartRequest => {}
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

    #[test]
    fn the_first_peer_waits_and_the_second_pairs_with_the_first_as_initiator() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        assert!(matches!(room.join(a), JoinOutcome::Waiting { ref evicted } if evicted.is_empty()));
        match room.join(b) {
            JoinOutcome::Paired { initiator, evicted } => {
                assert_eq!(initiator.peer_id, "alice:pc");
                assert!(evicted.is_empty());
            }
            _ => panic!("the second user must pair"),
        }
        assert_eq!(room.partner_of("alice:pc").unwrap().peer_id, "bob:phone");
        assert_eq!(room.partner_of("bob:phone").unwrap().peer_id, "alice:pc");
    }

    /// A 1:1 call has no third seat, and a refused join must not evict anybody on the way out.
    #[test]
    fn a_third_user_is_refused_and_the_room_is_unchanged() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        let (c, _rc) = peer("carol", "pc");
        room.join(a);
        room.join(b);
        assert!(matches!(room.join(c), JoinOutcome::Full));
        assert!(room.contains("alice:pc"));
        assert!(room.contains("bob:phone"));
        assert!(!room.contains("carol:pc"));
    }

    /// One device per user: the callee answering on a second device replaces the first, and the
    /// caller is re-paired with the newcomer (it stays the initiator, having arrived first).
    #[test]
    fn a_second_device_of_the_same_user_replaces_the_first() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b1, _rb1) = peer("bob", "phone");
        let (b2, _rb2) = peer("bob", "tablet");
        room.join(a);
        room.join(b1);
        match room.join(b2) {
            JoinOutcome::Paired { initiator, evicted } => {
                assert_eq!(initiator.peer_id, "alice:pc");
                assert_eq!(evicted.len(), 1);
                assert_eq!(evicted[0].peer_id, "bob:phone");
            }
            _ => panic!("the replacing device must pair"),
        }
        assert!(!room.contains("bob:phone"));
        assert_eq!(room.partner_of("alice:pc").unwrap().peer_id, "bob:tablet");
        // The evicted device's frames go nowhere: it is no longer in the room.
        assert!(room.partner_of("bob:phone").is_none());
    }

    /// A token for another conversation seats nobody: not a stranger in the empty second seat,
    /// and not a second device of the user already there - either would receive the candidates.
    #[test]
    fn a_token_for_another_group_is_refused_and_the_room_is_unchanged() {
        let room = P2pRoom::default();
        let (a, _ra) = peer_in("alice", "pc", "group-1", 8);
        let (mallory, _rm) = peer_in("mallory", "pc", "group-2", 8);
        let (alice_elsewhere, _rx) = peer_in("alice", "phone", "group-2", 8);
        room.join(a);
        assert!(matches!(room.join(mallory), JoinOutcome::OtherGroup));
        assert!(matches!(
            room.join(alice_elsewhere),
            JoinOutcome::OtherGroup
        ));
        assert!(room.contains("alice:pc"));
        assert!(!room.contains("mallory:pc"));
        assert!(!room.contains("alice:phone"));
        assert!(room.partner_of("alice:pc").is_none());
    }

    /// The relay never waits on the partner: a full queue returns at once with a reason, where a
    /// `send().await` would park the sender's socket task until the partner drained.
    #[test]
    fn delivery_to_a_full_queue_drops_at_once_and_says_why() {
        let (b, mut rb) = peer_in("bob", "phone", "group-1", 1);
        assert_eq!(deliver(&b.tx, crate::SignalMessage::PeerLeft), Ok(()));
        assert_eq!(
            deliver(&b.tx, crate::SignalMessage::PeerLeft),
            Err(DropReason::Full)
        );
        assert!(rb.try_recv().is_ok());
        drop(rb);
        assert_eq!(
            deliver(&b.tx, crate::SignalMessage::PeerLeft),
            Err(DropReason::Gone)
        );
    }

    #[test]
    fn leaving_names_the_peer_left_behind_once() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        room.join(a);
        room.join(b);
        assert_eq!(room.leave("bob:phone").unwrap().peer_id, "alice:pc");
        // A second leave of the same peer (an evicted socket closing late) reports nothing.
        assert!(room.leave("bob:phone").is_none());
        assert!(room.leave("alice:pc").is_none());
        assert!(room.is_empty());
    }

    /// A socket dying without a Close frame keeps its seat: the partner is named (to be told
    /// `PeerAway`), frames for the away seat have nowhere to go, and the room is not empty.
    #[test]
    fn a_lost_socket_leaves_its_seat_away_and_the_partner_is_named() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        room.join(a);
        room.join(b);
        assert_eq!(
            room.mark_absent("bob:phone").unwrap().unwrap().peer_id,
            "alice:pc"
        );
        assert!(room.contains("bob:phone"));
        assert!(room.partner_of("alice:pc").is_none());
        assert!(room.partner_is_away("alice:pc"));
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
        room.join(a);
        room.join(b);
        room.mark_absent("alice:pc");

        let (a2, _ra2) = peer("alice", "pc-again");
        match room.resume("alice:pc", a2) {
            ResumeOutcome::Resumed {
                replaced: None,
                partner:
                    PartnerState::Present {
                        partner,
                        i_am_initiator: true,
                        resumed: true,
                    },
            } => assert_eq!(partner.peer_id, "bob:phone"),
            _ => panic!("the caller must resume as the initiator, paired with bob"),
        }
        assert!(room.expire("alice:pc").is_none());
        assert_eq!(
            room.partner_of("bob:phone").unwrap().peer_id,
            "alice:pc-again"
        );
    }

    /// The server may not have noticed the old socket died: the resume replaces a seat still
    /// counted present, and hands the old holder back so its record can be closed.
    #[test]
    fn a_resume_before_the_server_noticed_the_loss_replaces_the_live_seat() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        let (b, _rb) = peer("bob", "phone");
        room.join(a);
        room.join(b);
        let (b2, _rb2) = peer("bob", "phone-again");
        match room.resume("bob:phone", b2) {
            ResumeOutcome::Resumed {
                replaced: Some(old),
                partner:
                    PartnerState::Present {
                        i_am_initiator: false,
                        resumed: true,
                        ..
                    },
            } => assert_eq!(old.peer_id, "bob:phone"),
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
        room.join(a);
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
        room.join(a);
        room.join(b);
        room.mark_absent("bob:phone");
        assert_eq!(
            room.expire("bob:phone").unwrap().unwrap().peer_id,
            "alice:pc"
        );
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
        room.join(a);
        room.join(b);
        room.mark_absent("bob:phone");
        // Alice's Close frame: nobody present to tell.
        assert!(room.leave("alice:pc").is_none());
        let (b2, _rb2) = peer("bob", "phone-again");
        assert!(matches!(
            room.resume("bob:phone", b2),
            ResumeOutcome::Resumed {
                partner: PartnerState::Alone { was_paired: true },
                ..
            }
        ));
    }

    /// The caller lost its socket while ringing and the callee answered meanwhile: the callee waits
    /// (`PartnerAway`), and the caller's resume is a FIRST pairing - no peer connection to keep.
    #[test]
    fn a_callee_arriving_while_the_caller_is_away_pairs_on_the_callers_resume() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        room.join(a);
        room.mark_absent("alice:pc");
        let (b, _rb) = peer("bob", "phone");
        assert!(matches!(room.join(b), JoinOutcome::PartnerAway { .. }));
        let (a2, _ra2) = peer("alice", "pc-again");
        assert!(matches!(
            room.resume("alice:pc", a2),
            ResumeOutcome::Resumed {
                partner: PartnerState::Present {
                    i_am_initiator: true,
                    resumed: false,
                    ..
                },
                ..
            }
        ));
    }

    #[test]
    fn a_lone_peer_has_no_partner() {
        let room = P2pRoom::default();
        let (a, _ra) = peer("alice", "pc");
        room.join(a);
        assert!(room.partner_of("alice:pc").is_none());
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
}
