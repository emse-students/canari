## P2 - some CAS returns reach MiConnect with no code and no state, and a client can stay out (diagnosed 2026-10-09)

target: 1.8.0

Read end to end on 2026-10-09 ([authentik](../infrastructure/authentik.md#the-hand-built-configuration-audited-2026-09-29),
last bullet): **52 % of the failing requests are server-side probes, not people**, the flow heals itself
once for a browser, and one Android client failed three times in a row. The CAS is not ours and no request
goes to its owner (user, 2026-10-10): the remedy is on our side, a MiConnect flow that restarts the
authorization instead of failing. **Owed**: **the MiConnect server's container log is unreadable since the
2026-10-07 restart (NUL bytes in the json log)**; a recreate of the container restores it, and only then
can the browser failure rate be re-counted without the probes.
