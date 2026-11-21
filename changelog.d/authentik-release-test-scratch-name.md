### Fixed - the MiConnect release self-test no longer fails when its random scratch directory name contains "up" or "stop"

`authentik-release.test.sh` counted a recreate by matching those words anywhere in a compose call, host paths included, so about one run in 430 failed `CI passed` on nothing; the checks now match the subcommand token and the scratch path is stripped first ([cicd](docs/wiki/cicd.md)).
