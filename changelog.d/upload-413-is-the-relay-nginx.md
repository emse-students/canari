### Found - the 1 MiB upload refusal on the legacy names is the relay's nginx default, not Cloudflare

The `413` page's own body is nginx's, and both relay files on the old VM carry no `client_max_body_size`. The two-line fix and its check are in [cloudflare-edge](docs/wiki/infrastructure/cloudflare-edge.md#a-request-body-over-1-mib-is-refused-with-a-413-on-the-legacy-names---it-is-the-relays-nginx-not-cloudflare-measured-2026-10-07-cause-found-2026-10-09); the gesture is on the owed table of the [backlog](docs/wiki/backlog.md).
