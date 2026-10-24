### Security - the SSR image moves from Node 25 to the patched Node 24 line

`Dockerfile.frontend-ssr` ran `node:25-alpine`, a line outside the October 2026 Brotli decoder fix (CVE-2026-111497, "node2shell"); it now runs `node:24-alpine` like the rest of `infrastructure/local` ([why the SSR is still on Node](infrastructure/local/Dockerfile.frontend-ssr)).
