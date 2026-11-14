## P3 - what the salon banner rule leaves to the server (2026-10-22)

target: 1.9.0

- **iOS extension timeout.** If the extension runs out of time while fetching or opening the seed, the system shows the push's original content, which carries the server's mention sound. The time-expiry handler should apply the blind-banner rule before it hands the content back.
- **An opened banner's mention is the server's word alone.** The text is proven, but whether it names this reader is not checked against it. Accepted for now, because the mention level is decided by the server too.
- **Source pins hold `\n`.** Several native source pins in `src/lib/mobile` match multi-line strings with `\n`, and would fail on a checkout with CRLF line endings. Normalise the source before matching.

_Context, from the former backlog section "The harness itself":_ Open findings about the instrument; the reasoning is on
[cross-client-harness-findings](../cross-client-harness-findings.md). **DECIDED 2026-10-18: the whole test tooling is reformed NOW, not after a wholesale rig change** (user: "on est a un nombre de test aberrant") - [WP-TEST-TOOLING-REFORM](decided-by-the-user-on-2026-10-18-every-design-question-answered.md); the "waits for a wholesale rig change" lines below are that reform's scope.
