### Added - the MLS cross-version gate carries a state through the build a rollback lands on

`mls-forward-compat.sh` now has today's code write a state holding the app's ledgers, the newest stable open it, read a frame and save it, and today reopen it: each field must come back unchanged or dropped whole, never corrupted ([cicd](docs/wiki/cicd.md#what-it-refuses-and-why-it-is-not-a-semver-rule)).
