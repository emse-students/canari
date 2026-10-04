### Changed - the X-Internal-Token HMAC is one check, not three copies

`core-service`, `social-service` and `chat-delivery-service` call one `verifyInternalToken` (a declared byte-for-byte copy per service); each guard's own refusal policy is unchanged ([backlog](docs/wiki/backlog.md)).
