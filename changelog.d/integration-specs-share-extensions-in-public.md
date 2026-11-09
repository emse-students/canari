### Fixed - parallel local runs of the social-service integration specs no longer lose a constraint to a sibling spec

TypeORM installed `btree_gist` and `uuid-ossp` inside whichever spec's throwaway schema met them first, and that spec's `DROP SCHEMA ... CASCADE` then removed `bookings_live_no_overlap` and the UUID defaults from every other spec's schema; a one-time jest `globalSetup` now puts both in `public`, as production has them. Test harness only: production is untouched ([cicd](docs/wiki/cicd.md)).
