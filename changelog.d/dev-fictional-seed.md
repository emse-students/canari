### Changed - dev holds a fictional seed, and nothing copies production into it any more

The weekly copy of production's database into `dev.canari-emse.fr` is deleted (GDPR, 2026-10-16); an on-demand `dev-reset` job empties dev and loads a generated, schema-checked seed of invented people and associations ([dev-environment](docs/wiki/infrastructure/dev-environment.md#3-the-data-a-fictional-seed-and-nothing-from-production-owner-2026-10-16)).
