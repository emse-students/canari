### Fixed - the MiConnect release self-test no longer fails when its random scratch directory name contains "up" or "stop"

`authentik-release.test.sh` counted a recreate by matching those words anywhere in a compose call, host paths included, so about one run in a few dozen failed `CI passed` on nothing; the scratch path is now stripped before matching ([cicd](docs/wiki/cicd.md)).
