## P2 - the local estate applies no migration file, so a table only a migration creates is missing (2026-10-22)

target: 1.9.0

The local estate's schema comes from TypeORM `synchronize`, and nothing runs `apps/*/src/migrations/*.sql` there. A raw-SQL table therefore never exists locally. On 2026-10-22, every salon send failed with `relation "channel_message_client_tombstones" does not exist` (migration 090), and `post_audiences` (071) was missing too. GRAINE-AUTH-1 read this as `never appeared`. Both files were applied by hand that day. The fix is for the local bring-up to call `apply_migrations` from `infrastructure/lib/migrations.sh`, as the deploy and the dev reset already do.

_Context, from the former backlog section "The harness itself":_ Open findings about the instrument; the reasoning is on
[cross-client-harness-findings](../cross-client-harness-findings.md). **DECIDED 2026-10-18: the whole test tooling is reformed NOW, not after a wholesale rig change** (user: "on est a un nombre de test aberrant") - [WP-TEST-TOOLING-REFORM](decided-by-the-user-on-2026-10-18-every-design-question-answered.md); the "waits for a wholesale rig change" lines below are that reform's scope.
