### Added - a group call's caller can end every ring with `room-empty` (server half)

`ring-end` takes the reason `room-empty`: from the caller it ends every member's ring; from a participant it stops only their own devices, since their view of a mesh is not evidence the room is empty ([calls](docs/wiki/frontend/modules/calls.md#an-emptied-room-ends-every-ring-wp-gc7-server-half-2026-11-16)).
