/**
 * JEST RUNS THIS SERVICE IN UTC, WHATEVER THE MACHINE'S ZONE (review of #2800).
 *
 * Every instant column here is `timestamp WITHOUT time zone`, and production runs this process and
 * Postgres in UTC - an invariant asserted at boot by `checkDatabaseClockAgreement`
 * (`src/utils/clock-agreement.ts`). A spec run in another zone tests an estate that does not exist:
 * the PostgreSQL integration specs read a `now()`-dated row an offset away from a `new Date()`, and
 * failed by exactly an hour on a Europe/Paris workstation while passing in CI.
 *
 * A global setup runs in jest's parent process before any worker is forked, and every worker
 * inherits its environment - so the zone is UTC from each worker's first line. `.cjs`, so the
 * `ts-jest` transform (which matches `.ts` and `.js`) leaves it alone.
 */
module.exports = async () => {
  process.env.TZ = 'UTC';
};
