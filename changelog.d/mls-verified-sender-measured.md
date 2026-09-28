### Security - the MLS sender a message was verified against now reaches the app, and a disagreement with its envelope is reported

Every decrypted DM and key-group frame now carries the credential OpenMLS verified; where it contradicts the sender the server wrote on the envelope, the client logs `[MLS] SENDER MISMATCH` and reports it to `POST /api/mls/sender-mismatch` - measured before it refuses, as decided for Graine v2 ([channel-encryption](docs/wiki/protocols/channel-encryption.md#21-graine-v2-an-author-that-is-proven-a-ciphertext-bound-to-its-place---decided-by-the-user-2026-09-28)).
