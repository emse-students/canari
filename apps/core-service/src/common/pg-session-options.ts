/**
 * The PostgreSQL session settings every connection of this service starts with, as the libpq
 * `options` startup string (node-postgres passes it through).
 *
 * `timezone=UTC`: `CURRENT_TIMESTAMP` and `now()` defaults on zone-less `timestamp` columns are
 * stored on the SESSION's wall clock, and the driver reads them back in the process's zone
 * (`TZ=UTC` in the image). The two agree only while both are UTC, and the server's own default
 * (postgresql.conf, a role or database setting) is not ours to rely on.
 */
export const PG_SESSION_OPTIONS = '-c timezone=UTC';
