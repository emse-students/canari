/**
 * ONCE, BEFORE ANY WORKER: the database-wide extensions the integration specs' entities make TypeORM
 * install, put where production keeps them (`public`), so no throwaway schema ever owns one.
 *
 * Why: a DataSource whose entities hold an `@Exclusion` (Booking) or a `uuid_generate_v4()` default
 * runs `CREATE EXTENSION IF NOT EXISTS "btree_gist"` / `"uuid-ossp"` on connect, with no SCHEMA - so,
 * on a database that has not got the extension yet, it lands in the FIRST schema of the spec's
 * `search_path`, i.e. the spec's own throwaway schema. That spec's `DROP SCHEMA ... CASCADE` then
 * drops the extension and, with it, every exclusion constraint and column default that depends on it
 * in EVERY OTHER spec's schema, silently: a sibling spec still running on the same database finds
 * `bookings_live_no_overlap` gone and two overlapping bookings both succeed. Measured 2026-11-09
 * with 3 jest workers (CI's `--runInBand` serialises the specs and hid it): `bookings.service`
 * integration failed 2 tests in 1 run of 11, and the extension was absent after every run.
 * Production is unaffected: migration 087 installs `btree_gist` in `public`, so TypeORM's statement
 * is a no-op there.
 *
 * A no-op without `SOCIAL_IT_DATABASE_URL` (the unit run) and when the extensions already exist.
 */
module.exports = async () => {
  const url = process.env.SOCIAL_IT_DATABASE_URL;
  if (!url) return;
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const extension of ['btree_gist', 'uuid-ossp']) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS "${extension}" SCHEMA public`);
    }
  } finally {
    await client.end();
  }
};
