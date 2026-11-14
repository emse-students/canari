### Added - a probe that asks whether E2E-encrypted call frames cross Cloudflare Realtime's SFU intact

`scheduled.yml`'s `sfu-probe` job (dispatch only, `development` environment) pushes the app's encrypted audio and VP8 frames through Cloudflare's sessions/tracks API and passes only on frames decrypted and byte-identical on the other side; the SFU app's pair is also wired, optional, into chat-delivery-service ([sfu-e2ee-probe](tools/sfu-e2ee-probe/README.md), [calls-revival-plan](docs/wiki/frontend/modules/calls-revival-plan.md#14-probes-of-2026-10-16-clients)).
