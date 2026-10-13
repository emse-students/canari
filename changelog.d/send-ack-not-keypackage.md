### Changed - the slow reply after login does not wait on the KeyPackage, measured

An instrumented build on the Mi 9T sent five replies during or around the post-login KeyPackage round. Every ack took 543-836 ms, and no step of the send waited on that round. The slow acks seen before line up with the conversation's own catch-up, which a send must wait for ([notification-to-conversation-latency](docs/wiki/frontend/notification-to-conversation-latency.md#the-21-s-reply-ack-waits-on-the-conversations-own-catch-up-not-on-the-keypackage-2026-10-13)).
