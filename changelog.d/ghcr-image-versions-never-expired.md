### Added - GHCR image versions are now pruned weekly

`build.yml` pushes three tags per service on every release and nothing ever deleted one -
6048 versions of `frontend` alone, measured 2026-09-24. `scheduled.yml` now keeps the 30
newest per service and deletes the rest, Sundays.
