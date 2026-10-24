/* global expect, jest */
/**
 * THE TIME BUDGET OF AN INTEGRATION SPEC, set once for the class rather than file by file.
 *
 * A `*.integration.spec.ts` builds its schema in `beforeAll` - DDL on a PostgreSQL that may have
 * just started - and jest's default budget of 5 s bounds that hook like any other. Measured on a
 * freshly started `postgres:16-alpine` (2026-10-22, 45 cold starts, `removal-bound.integration`):
 * the schema build took from 0.17 s to 4.5 s, and past 5 s every test of the file failed as
 * "Exceeded timeout of 5000 ms for a hook". So 5 s is not a bound of the work, only of the host's
 * mood, and a slow runner meets it on any file; 60 s is. A test or hook that needs more still says
 * so itself (a deadlock costs `deadlock_timeout` per round, see `bookings.integration.spec.ts`).
 *
 * Unit specs keep jest's default: nothing they do waits on a server. Selected by the file name,
 * the same pattern CI's `test-social-integration` job selects them by.
 */
if ((expect.getState().testPath ?? '').endsWith('.integration.spec.ts')) {
  jest.setTimeout(60_000);
}
