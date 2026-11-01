## P2 - a migration the owner must approve has no gate (found 2026-11-01)

`apply_migrations` (`infrastructure/lib/migrations.sh`, called from
`infrastructure/deploy/deploy-environment.sh`) applies EVERY unrecorded migration on a deploy, with no
per-migration hold. Migrations 034, 038 and 042 were each written as "owed the owner's yes" and went
into production with the `v1.5.0` and `v1.5.1` deploys anyway; the yes was a sentence in the backlog,
never a gate. They were additive, so nothing broke - the next one may not be.

**The owner's rule (2026-11-01): a migration is applied only if it is additive, reviewed, and with a
backup taken just before.** Today that rule lives in people's heads.

**The gate that would lift this:** a per-migration hold marker (for example a first-line comment
`-- canari:hold-for-owner` in the `.sql`) that `apply_migrations` REFUSES to run unless the deploy
carries the matching release input naming that migration, and a destructive-looking statement (`DROP`,
`ALTER ... TYPE`, a rewrite) refused the same way. Test: a case in
`.github/scripts/tests/deploy-migrations.test.sh` where a held migration makes the deploy fail with
the migration named, and passes once the input names it. Until it exists, never write "owed the
owner's yes" for a migration: it will apply on the next deploy.
