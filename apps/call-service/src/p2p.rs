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

use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use crate::{bump, CallLedger, PeerId};

/// One participant of a two-person room: where to write its frames, and its record.
#[derive(Clone)]
pub(crate) struct P2pPeer {
    pub(crate) peer_id: PeerId,
    pub(crate) user_id: String,
    pub(crate) tx: mpsc::Sender<crate::SignalMessage>,
    pub(crate) ledger: Arc<CallLedger>,
}

/// What a `Join` did to the room. Decided under the room's lock, acted on after it is released,
/// because sending a frame is async and a lock must never be held across an await.
pub(crate) enum JoinOutcome {
    /// The room holds only this peer: it waits for the other party.
    Waiting {
        /// Devices of the same user that this join replaced (one device per user per call).
        evicted: Vec<P2pPeer>,
    },
    /// The room now holds two peers. `initiator` is the one that was there first.
    Paired {
        initiator: P2pPeer,
        evicted: Vec<P2pPeer>,
    },
    /// Two OTHER users already hold the room; a 1:1 call has no third seat. Nothing changed.
    Full,
}

/// A room in peer-to-peer mode: at most two peers of two distinct users, in arrival order.
#[derive(Default)]
pub(crate) struct P2pRoom {
    peers: Mutex<Vec<P2pPeer>>,
}

impl P2pRoom {
    /// Admits `peer`, replacing any device of the same user already in the room.
    ///
    /// The capacity check runs BEFORE the eviction, so a refused join leaves the room exactly as
    /// it found it - a third user must not be able to knock a participant out by trying to enter.
    pub(crate) fn join(&self, peer: P2pPeer) -> JoinOutcome {
        let Ok(mut peers) = self.peers.lock() else {
            // A poisoned lock means a panic while holding it; refusing is the only answer that
            // cannot put a third party into a call. The caller logs the refusal.
            return JoinOutcome::Full;
        };
        let others = peers.iter().filter(|p| p.user_id != peer.user_id).count();
        if others >= 2 {
            return JoinOutcome::Full;
        }
        let mut evicted = Vec::new();
        peers.retain(|p| {
            if p.user_id == peer.user_id {
                evicted.push(p.clone());
                false
            } else {
                true
            }
        });
        peers.push(peer);
        if peers.len() == 2 {
            JoinOutcome::Paired {
                initiator: peers[0].clone(),
                evicted,
            }
        } else {
            JoinOutcome::Waiting { evicted }
        }
    }

    /// Removes `peer_id` and returns the peer left behind, if there is one and `peer_id` was
    /// actually in the room. An evicted sibling's socket closing later finds itself already gone
    /// and must not tell the remaining peer that its partner left.
    pub(crate) fn leave(&self, peer_id: &str) -> Option<P2pPeer> {
        let mut peers = self.peers.lock().ok()?;
        let before = peers.len();
        peers.retain(|p| p.peer_id != peer_id);
        if peers.len() == before {
            return None;
        }
        peers.first().cloned()
    }

    /// The peer a frame from `peer_id` is addressed to. `None` when the sender is not in the
    /// room (evicted) or is alone in it.
    pub(crate) fn partner_of(&self, peer_id: &str) -> Option<P2pPeer> {
        let peers = self.peers.lock().ok()?;
        if !peers.iter().any(|p| p.peer_id == peer_id) {
            return None;
        }
        peers.iter().find(|p| p.peer_id != peer_id).cloned()
    }

    /// Whether `peer_id` still holds a seat.
    pub(crate) fn contains(&self, peer_id: &str) -> bool {
        self.peers
            .lock()
            .map(|p| p.iter().any(|x| x.peer_id == peer_id))
            .unwrap_or(false)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.peers.lock().map(|p| p.is_empty()).unwrap_or(true)
    }
}

/// The three frames a peer may relay, named for the ledger.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RelayedKind {
    Offer,
    Answer,
    Ice,
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{count, RoomMode};

    fn peer(user: &str, device: &str) -> (P2pPeer, mpsc::Receiver<crate::SignalMessage>) {
        let (tx, rx) = mpsc::channel(8);
        let peer_id = format!("{user}:{device}");
        (
            P2pPeer {
                peer_id: peer_id.clone(),
                user_id: user.to_string(),
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
