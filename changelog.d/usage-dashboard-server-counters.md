### Added - the usage dashboard's anonymous counters and their read

The server now counts, for the platform admins only, the distinct people who use Canari per Paris
day, week and month (overall, per platform category, per app version, with no id stored), a
week-by-hour map, and six daily activity totals; the figures are kept in `usage_figures` and served
by `GET /api/admin/usage` ([usage-dashboard](docs/wiki/usage-dashboard.md)).
