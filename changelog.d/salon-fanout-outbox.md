### Fixed - a salon message whose process died before its broadcast is broadcast and pushed at the next boot

The broadcast and the push now come from an outbox entry written in the send's transaction ([social-service](docs/wiki/services/social-service.md)).
