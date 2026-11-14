## P2 - a re-admitted device calls its own exclusion window a loss, and reconciles for it (2026-08-26, widened 2026-08-30)

target: 1.8.0

Not built (queued by the user on 2026-10-10: designed in the wiki first, then built under an adversarial review): an ENTITLEMENT FLOOR per group at every entitlement START (re-admission AND a fresh device after
a revocation wipe), keyed on the stream position or a surfaced frame epoch. Confirm with GRP-8 AND
HEAL-REVOKE-5. Never read "no fingerprint repeats across runs" as "new messages". **The policy question
is DECIDED (user, 2026-10-14): a Remove holds**, and answering peers now withhold every member's
window - so a withheld message is re-asked on every connection until this floor exists; the server
side of it, membership intervals, is migration `030`
([history-reconciliation](../protocols/history-reconciliation.md#a-remove-holds-against-a-later-re-add---the-answering-peer-withholds-the-window-decided-by-the-user-2026-10-14)).
A sent message is now dated by the server's receive time; only copies written before that change are
undated, and those are placed by their client clock with a one-hour margin
([measurements and the discriminator](../protocols/campaign-measured-defects.md#a-re-admitted-device-calls-its-own-exclusion-window-a-loss-2026-08-26),
[open-questions](../open-questions.md#is-a-remove-meant-to-be-durable-against-a-later-re-add)).
**`minClientVersion`:** the withholding runs on the ANSWERING device, so an answerer
on an older build still sends the window unfiltered; the guarantee is complete only once
`minClientVersion` reached `1.2.9` on production on 2026-10-29 (#1878), by [the floor rule](../legacy-compatibility.md#the-floor-rule-raised-when-both-stores-serve-the-latest-update-owner-2026-10-24). **And a known abuse, accepted with the decision:** a member can remove and re-add someone
to open an artificial window, making that span unrestorable to every new device while the person
stays; nothing tells it from a real removal.

_Context, from the former backlog section "MLS state, device healing and delivery - the defects the campaign measured":_ Open entries only; each carries a title, what is left and a link. The measurements, recurrences and
refuted readings are on [campaign-measured-defects](../protocols/campaign-measured-defects.md), the
cold-start ledger on [history-reconciliation](../protocols/history-reconciliation.md).
