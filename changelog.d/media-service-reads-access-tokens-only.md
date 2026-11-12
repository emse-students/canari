### Changed - media-service accepts an access token only, with an expiry

A bearer token must carry an expiry and be an access token, the checks chat-gateway makes on a socket ([media-service](docs/wiki/services/media-service.md#what-the-service-asks-of-a-bearer-token-2026-11-12)). One question parked: whether a portaled dialog keeps its initial focus ([open-questions](docs/wiki/open-questions.md)).
