## P2 - the retired-device reaper is built OFF; its activation is owed to the owner (2026-11-01)

Decided by the owner on 2026-11-01 ("Oui, la construire"), after the fourth hand pass revoked 286
devices with no session and no push token that kept filling the queue. Built in
`chat-delivery-service`, daily, behind `RETIRED_DEVICE_REAPER` (a literal `off` in
`infrastructure/deploy/env-manifest.tsv`); mechanism on the
[service page](../services/chat-delivery.md#the-retired-device-reaper-built-off-2026-11-01).

- **Owed to the owner, in order**: read the rule and run the two read-only statements of the
  [audit page](../infrastructure/prod-queue-and-epoch-audit-2026-10-12.md#the-dry-run-read-only-as-the-owner-runs-it)
  on production; then a commit setting the manifest literal (and `deploy-env.test.sh`'s expectation)
  to `dry-run`, and read the `[RETIRED_REAPER]` lines of the next run; then the same commit with `on`.
- **Open question for the owner**: clause 5 (a newer device of the same owner and platform, live
  session, key package newer than the oldest queued row) would have left at least 25 % of the 292
  of the 2026-11-01 re-measure in place, possibly about half
  ([measured bounds](../infrastructure/prod-queue-and-epoch-audit-2026-10-12.md#clause-5-against-the-hand-passes---it-would-not-have-named-all-of-them)).
  The second statement counts them. Whether those are reaped on weaker evidence is a separate decision; the clause was not weakened.
- **Closed when**: the switch is `on` in production, and a re-measure a week later finds the
  no-session, no-push-token population with seats held below one run's cap.
