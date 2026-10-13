### Security - the server refuses a salon message that carries no Graine v2 signature

Every client the `1.0.3` floor admits signs every salon row, so social-service now answers an unsigned one with a 400 `CHANNEL_SIGNATURE_REQUIRED` and stores nothing: a modified client can no longer post an unsigned row under a v1 session it holds ([channel-encryption 21.8](docs/wiki/protocols/channel-encryption.md#218-the-server-refuses-an-unsigned-salon-row-2026-10-13)).
