### Security - presence is visible only to people sharing a conversation or a community

`GET /api/presence` now answers only for the asked users who share a live conversation or a community with the caller (absent otherwise, never a 401/403), asking chat-delivery and social-service; the 10 s poll stays until the push is built. Two additive indexes serve the per-poll viewer lookup (chat-delivery 031, social-service 089) ([chat-gateway](docs/wiki/services/chat-gateway.md#who-may-see-whose-presence-wp-presence-2026-10-18)).
