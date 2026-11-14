## P2 - a group call holds one device per user: prove the second device replaces the first

target: 1.7.0

Group-call keys are per user, so two devices of one person must never both be in one group call
(decided 2026-11-13, reversible:
[open-questions](../open-questions.md#a-group-call-holds-one-device-per-user-decided-2026-11-13-reversible)).
call-service's p2p seats already evict a user's sibling device; what is owed is the proof that the
GROUP path keeps it: a call-service test of a mesh in which a second device of a seated user joins
(the first gets `PeerLeft`, every other participant one new `PeerReady` for that user, no third leg),
and a client test that the replaced device's leg closes without ending the call
([calls](../frontend/modules/calls.md#one-key-per-sender-wp-gc1-2026-11-13)). Delete when both tests
are in.
