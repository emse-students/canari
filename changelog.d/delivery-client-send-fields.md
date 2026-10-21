### Changed - chat-delivery: `POST /mls/send` accepts only the fields a client sends

Any other field is refused with a 400 naming it. Recipients and handshake flags are set by the
service's own callers, which never cross that route.
