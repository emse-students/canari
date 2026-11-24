## P3 - the migration 056 integration spec fails when the integration specs run in parallel

target: 1.8.0

**Seen 2026-11-24** (review of #4064): `056_dm_groups_self_kind.integration.spec.ts` passes alone and in
band (`--runInBand`, which is how the `test-chat-delivery-integration` job in `ci.yml` runs it), and
fails eight cases when the whole chat-delivery suite runs in parallel against one database:
`constraint "chk_dm_groups_kind" of relation "dm_groups" does not exist`.

**What it is.** Migration 056 guards its CHECK with
`IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_dm_groups_kind')`, which is scoped to
neither the table nor the schema. Every integration spec works in its own throwaway schema of the same
database, so a second spec's schema that already holds that constraint makes 056 skip creating it in
its own. Production is unaffected: it has one `dm_groups`, and the migration has been applied there.

**Why not edit 056.** Editing an applied migration changes nothing in a database that already ran it,
and the deploy warns `changed after it was applied - Add a new migration instead of editing an
applied one` (`infrastructure/lib/migrations.sh`).

**The fix owed.** On the test side: the 056 spec applies the migration to a database where no other
schema can answer the guard. Either it gets a database of its own (created and dropped by the spec on
the same server), or the integration jest config pins `--runInBand` locally, as CI does, so the local
command cannot diverge from the gate. Every later guard on a catalogue name is scoped
(`conrelid = '"<table>"'::regclass`) from the next migration on.

**The test that lifts it.** `bun run test` in `apps/chat-delivery-service` with
`CHAT_DELIVERY_IT_DATABASE_URL` set and no `--runInBand` reports the 056 spec green.
