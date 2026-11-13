//! The seats of an SFU room, and who each forwarded track belongs to (WP-GC4, 2026-11-13).
//!
//! A GROUP call goes through this relay past the mesh cap (owner decision D2: our Rust relay must
//! carry a group call, E2E transforms in the path throughout). Two things the 1:1 SFU never needed
//! are owed for that, and both live here, pure, so they are tested without a socket:
//!
//! - **THE SEAT CAP.** chat-delivery-service signs `max_seats` into every room token; this service
//!   enforces it. The reservation is ONE synchronous step under ONE lock ([`SfuSeats::reserve`]),
//!   taken while the room map's own entry is held, so two joins can never both see a free seat and
//!   both take it - never check-then-insert across an await. A seat is released by the peer that
//!   holds it and by no other ([`SfuSeats::release`]), so a device replaced by a sibling of the
//!   same user cannot free the seat its sibling now holds.
//! - **WHO SENT A FORWARDED TRACK.** A group call's media is keyed PER SENDER (WP-GC1,
//!   `frontend/src/lib/utils/callKeys.ts`), so each receiver must know whose frames a track carries
//!   to pick the key that opens them. The SFU says it in the STREAM id of every track it forwards:
//!   the stream id IS the sender's user id ([`forwarded_stream_id`]). A browser reads it in `ontrack`
//!   as `event.streams[0].id`. The SFU never touches the payload: it learns nothing it could open.

use std::collections::HashMap;

/// The seats of a room whose token names no `max_seats`: a 1:1 call, as every SFU room was before
/// group calls.
pub(crate) const DEFAULT_SFU_SEATS: usize = 2;

/// The most seats an SFU room may hold, whatever a token says. Every participant's frames are
/// forwarded to every other one, so the relay's egress grows with the square of the room: at 8
/// audio participants that is 56 forwarded Opus streams (~50 kbit/s each, ~2.8 Mbit/s), which the
/// host carries; a larger call is a product decision, not a token's.
pub(crate) const MAX_SFU_SEATS: usize = 8;

/// What a reservation did. Decided under the room's seat lock; acted on after it is released.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Reservation {
    /// Seated. `replaced` is the peer id of a sibling device of the same user that held the seat:
    /// the seat is now this peer's, and the sibling is evicted by the caller.
    Seated { replaced: Option<String> },
    /// `max_seats` OTHER users already hold the room. Nothing changed.
    Full { max_seats: usize },
    /// The token names another seat count than the room was opened with. Nothing changed.
    OtherSeats { room: usize, token: usize },
}

/// The users holding an SFU room's seats, one peer (device) each.
#[derive(Debug)]
pub(crate) struct SfuSeats {
    max_seats: usize,
    /// user id -> the peer id holding that user's seat.
    holders: HashMap<String, String>,
}

impl SfuSeats {
    /// An empty room of `max_seats`, read from the token of the join that opens it.
    pub(crate) fn new(max_seats: usize) -> Self {
        Self {
            max_seats,
            holders: HashMap::new(),
        }
    }

    /// The room's cap.
    pub(crate) fn max_seats(&self) -> usize {
        self.max_seats
    }

    /// How many users hold a seat.
    pub(crate) fn held(&self) -> usize {
        self.holders.len()
    }

    /// Seats `peer_id` of `user_id`, whose token signs `token_seats`. A user who already holds a
    /// seat keeps it on the new device (one device per user per call, as before). A token that
    /// disagrees with the room's cap is refused, as a p2p room refuses one.
    pub(crate) fn reserve(
        &mut self,
        user_id: &str,
        peer_id: &str,
        token_seats: usize,
    ) -> Reservation {
        if token_seats != self.max_seats {
            return Reservation::OtherSeats {
                room: self.max_seats,
                token: token_seats,
            };
        }
        if let Some(held) = self.holders.get_mut(user_id) {
            let replaced = std::mem::replace(held, peer_id.to_string());
            return Reservation::Seated {
                replaced: Some(replaced),
            };
        }
        if self.holders.len() >= self.max_seats {
            return Reservation::Full {
                max_seats: self.max_seats,
            };
        }
        self.holders
            .insert(user_id.to_string(), peer_id.to_string());
        Reservation::Seated { replaced: None }
    }

    /// Frees the seat of `user_id` if `peer_id` is the device holding it, and says whether it did.
    /// A device whose seat a sibling took over frees nothing.
    pub(crate) fn release(&mut self, user_id: &str, peer_id: &str) -> bool {
        if self.holders.get(user_id).is_some_and(|p| p == peer_id) {
            self.holders.remove(user_id);
            return true;
        }
        false
    }
}

/// Whether a token's `max_seats` is one an SFU room may hold.
pub(crate) fn sfu_seats_allowed(max_seats: usize) -> bool {
    (DEFAULT_SFU_SEATS..=MAX_SFU_SEATS).contains(&max_seats)
}

/// The STREAM id the SFU gives every track it forwards from the peer `publisher_peer_id`
/// (`<user_id>:<device uuid>`): the publisher's USER id, which is what a receiver keys its frames by
/// (`deriveGroupCallKeys`, context `<callId>|<userId>`). Not the peer id: the device is nobody's key,
/// and the `:` it carries is not a character an `a=msid` identifier may hold (RFC 8830, token-char).
pub(crate) fn forwarded_stream_id(publisher_peer_id: &str) -> String {
    publisher_peer_id
        .split(':')
        .next()
        .unwrap_or(publisher_peer_id)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seats_up_to_the_cap_and_refuses_the_next_user() {
        let mut room = SfuSeats::new(3);
        for (u, p) in [("a", "a:1"), ("b", "b:1"), ("c", "c:1")] {
            assert_eq!(
                room.reserve(u, p, 3),
                Reservation::Seated { replaced: None }
            );
        }
        assert_eq!(
            room.reserve("d", "d:1", 3),
            Reservation::Full { max_seats: 3 }
        );
        assert_eq!(room.held(), 3);
    }

    #[test]
    fn a_second_device_of_a_seated_user_takes_its_seat_even_when_full() {
        let mut room = SfuSeats::new(2);
        room.reserve("a", "a:1", 2);
        room.reserve("b", "b:1", 2);
        assert_eq!(
            room.reserve("a", "a:2", 2),
            Reservation::Seated {
                replaced: Some("a:1".to_string())
            }
        );
        assert_eq!(room.held(), 2);
    }

    #[test]
    fn only_the_device_holding_a_seat_frees_it() {
        let mut room = SfuSeats::new(2);
        room.reserve("a", "a:1", 2);
        room.reserve("a", "a:2", 2);
        // The replaced device's socket ends afterwards: the seat is its sibling's.
        assert!(!room.release("a", "a:1"));
        assert_eq!(room.held(), 1);
        assert!(room.release("a", "a:2"));
        assert_eq!(room.held(), 0);
        assert!(!room.release("a", "a:2"));
    }

    #[test]
    fn a_freed_seat_seats_the_next_user() {
        let mut room = SfuSeats::new(2);
        room.reserve("a", "a:1", 2);
        room.reserve("b", "b:1", 2);
        assert!(room.release("b", "b:1"));
        assert_eq!(
            room.reserve("c", "c:1", 2),
            Reservation::Seated { replaced: None }
        );
    }

    #[test]
    fn a_token_naming_another_cap_is_refused_and_changes_nothing() {
        let mut room = SfuSeats::new(5);
        room.reserve("a", "a:1", 5);
        assert_eq!(
            room.reserve("b", "b:1", 8),
            Reservation::OtherSeats { room: 5, token: 8 }
        );
        assert_eq!(room.held(), 1);
    }

    #[test]
    fn the_allowed_caps_are_two_to_eight() {
        assert!(!sfu_seats_allowed(0));
        assert!(!sfu_seats_allowed(1));
        assert!(sfu_seats_allowed(2));
        assert!(sfu_seats_allowed(MAX_SFU_SEATS));
        assert!(!sfu_seats_allowed(MAX_SFU_SEATS + 1));
    }

    #[test]
    fn the_stream_id_is_the_publisher_user_id() {
        let user = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
        assert_eq!(
            forwarded_stream_id(&format!("{user}:9a7c3e1e-0000-4000-8000-000000000001")),
            user
        );
    }

    #[test]
    fn a_uuid_user_id_is_a_valid_msid_identifier() {
        // RFC 8830: an msid identifier is 1 to 64 token-char (RFC 4566).
        let token_char = |c: char| matches!(c, '!' | '#'..='\'' | '*' | '+' | '-' | '.' | '0'..='9' | 'A'..='Z' | '^'..='~');
        let id = forwarded_stream_id("1b4e28ba-2fa1-11d2-883f-0016d3cca427:any-device");
        assert!(!id.is_empty() && id.len() <= 64);
        assert!(id.chars().all(token_char), "{id} is not an msid identifier");
    }
}
