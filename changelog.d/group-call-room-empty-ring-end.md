### Added - an emptied group call stops every member's system ring (server half)

`ring-end` takes the reason `room-empty`: from one who held a room token for that call it stops every member's ring, and from a participant it never marks the ring ended, so the room stays joinable ([calls](docs/wiki/frontend/modules/calls.md#an-emptied-room-ends-every-ring-wp-gc7-server-half-2026-11-16)).
