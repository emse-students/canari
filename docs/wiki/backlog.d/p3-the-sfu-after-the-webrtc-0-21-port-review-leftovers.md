## P3 - the SFU after the webrtc 0.21 port: review leftovers (2026-10-27)

Nothing live reaches the SFU media plane (1:1 calls are peer to peer; only `test-call-service-e2e`
calls through it), so each is for the day group calls use it
([calls](../frontend/modules/calls.md#the-webrtc-021-port-built-2026-10-27)).

- **A dead track is never removed from `Room.tracks`**, so a later joiner is subscribed to a
  publisher that left (its leg waits forever for packets).
- **A Join racing `publish_track` can subscribe the same peer twice** to one track: the peer is
  inserted in `room.peers` before it takes the `tracks` lock, so both paths see it.
- **Gathering is IPv4 only** (`0.0.0.0:0`); an IPv6-only path is untested.
