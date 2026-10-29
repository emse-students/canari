### Changed - presence ids travel in a POST body, never in the URL

A reverse-proxy log scanner flagged the very long `GET /api/presence?users=...` query strings: the
client now sends `POST /api/presence` with the ids in its body, split at the 1000-id cap, and the
legacy GET stays, counted, for installed clients
([chat-gateway](docs/wiki/services/chat-gateway.md#the-ids-travel-in-a-body-never-in-the-url-2026-10-28)).
