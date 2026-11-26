### Changed - a retired replica's error lines are printed before the deploy removes it

`retire` used to delete the only copy of what a replica logged during its drain, so the two `502`s of one release could not be traced to a hop; the lines are now printed first, and the rolling test shows them when a POST fails ([cicd](docs/wiki/cicd.md)).
