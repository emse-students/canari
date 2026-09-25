### Found - the Cloudflare-to-host-nginx audit, and what actually protects the shared host

Re-checked every deliberate Cloudflare zone setting against the live host: TLS floor holds, the
`www.` question is moot (no such DNS record), CSP and CSRF were never Cloudflare's job. The
"DDoS absorption" row turned out to be answered by CrowdSec, already running on every vhost and
banning for real - but its log-parsing half reads one shared `access.log`, so Authentik's own log,
where a password is actually tried, is parsed by nothing
([backlog](docs/wiki/backlog.md#p2---crowdsec-cannot-see-the-one-log-where-a-password-is-actually-tried-measured-2026-09-25)).
Full audit: [estate-migration](docs/wiki/infrastructure/estate-migration.md#what-the-edge-did-that-the-origin-must-now-do).
