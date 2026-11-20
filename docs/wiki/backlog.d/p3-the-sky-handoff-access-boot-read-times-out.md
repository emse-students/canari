## P3 - core-service's boot read of Sky's handoff access timed out against MiConnect, once (2026-11-20)

target: 1.7.3

At the boot of the `1.7.1` stable deploy (2026-11-20 03:59:42Z) core-service logged `ERROR [HandoffAccess] [HANDOFF_ACCESS] site=sky app=sky could not be read: MiConnect read unreachable: /api/v3/policies/bindings/: TimeoutError: The operation timed out.`, while the two other handoff sites read fine twelve seconds earlier (`migallery` and `le-cercle`, `bindings=0 flow_bindings=0 ... default_access=true`). The identity provider was up for four days and its apply began two minutes later, so neither a restart nor the apply explains it. One occurrence: the `1.7.0` deploy read showed no such line.

**What is not known:** whether the boot read has a retry and what the site's access decision is while it is unread (the line says it "could not be read", the policy for that state is in [sessions](../sessions.md)); whether the read of Sky's bindings is simply the slowest of the three. **What deciding it takes:** the next two production boots; if it repeats, the read gets its own timeout and a named fail-closed or fail-open decision, written with the line. Reading of the day: [device-verification](../device-verification.md#the-production-reading-of-2026-11-20-the-171-stable-deploy).
