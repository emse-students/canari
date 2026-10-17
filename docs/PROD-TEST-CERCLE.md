# Production runbook - Canari <-> Le Cercle link

The operational runbook (hosts, secret inventory, probes against the real estates) is kept in a
private folder, not in this public repository. What stays here is what guards the code.

Related: [`docs/wiki/cotisations.md`](wiki/cotisations.md) for how tiers and tags work.

## What the link is

- **Cercle -> Canari:** `GET /api/public/cotisant-status` answers with a tier for a member. It is
  guarded by an API key compared timing-safe; an EMPTY key on the Canari side refuses everyone, it
  is never an "open" default.
- **Canari -> Cercle:** an HMAC-signed `balance_topup` webhook, idempotent on the payment intent.
- **Shared identity:** the OIDC `sub` = the Canari `userId` = the Cercle user uuid.

## Lessons that guard the code

1. A missing route answers a SvelteKit **HTML 404**, which the dispatcher records as an ordinary
   failure - "the webhook does not work" and "the webhook is not deployed" look identical from
   Canari. Probe the route before blaming the secret.
2. The receiver must strip the **`sha256=` prefix** before hex-decoding the signature. Without it
   the decoded buffer is empty and every delivery is a 401, which reads exactly like a secret
   mismatch. Check this BEFORE comparing secrets.
3. The same secret wears a different variable name on each side; the API key is a repository
   secret that the deploy writes into the environment file, so editing that file by hand is silently
   reverted at the next deploy.
4. The tier is the tier's `variantKey`, not its display name. Convert the auto-provisioned base tier
   rather than deleting it: renaming re-tags every holder in one transaction, deleting orphans them.
5. The Cercle re-queries Canari at login and at each session-JWT refresh, so the JWT lifetime IS the
   cache TTL.
6. The Cercle ledger has no reversal movement: a consumption charged to the wrong account cannot be
   corrected, so verify the identity mapping before opening a till.
7. A test shortcut that moves a real balance is not a test: the one that credited the pressing admin
   was removed (2026-08-28). Rows it left carry the `pi_canari_test_` intent prefix.

## Troubleshooting

| Symptom | First check |
| --- | --- |
| Everyone bounced to `/unauthorized` | the API key on both sides matches; the association slug is `cercle`; Canari logs for `403` on `cotisant-status` |
| Webhook `401` | the receiver is not stripping the `sha256=` prefix, or a proxy re-serialized the body |
| Webhook "not working" but no `401` | the route is not deployed (HTML 404) |
