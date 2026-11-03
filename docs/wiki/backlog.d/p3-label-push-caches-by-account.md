## P3 - label each Graine seed and channel-key entry with the account that wrote it, and drop a revoked account's entries in its own wipe

`graine_seeds.json` and `channel_keys.json` (the push service's caches, sealed under the install's
native cache key) carry no account label. So the per-account wipe of a revoked device that another
account still uses LEAVES them - deciding entry by entry is not possible, and deleting the files would
cost the remaining account its rich notifications until its next sync. Decided in the round-7 review of
#2919: left, recorded in [auth](../frontend/modules/auth.md) (the revoked per-account table).

Owed: write the account id beside each entry when the push service or the page stores it, and have
`wipeAccountOfRevokedDevice` (and the deleted-account wipe) drop exactly the entries ONLY that account
wrote - an allowlist by label, never a guess from the community. Unlabelled legacy entries stay until
their next rewrite labels them.
