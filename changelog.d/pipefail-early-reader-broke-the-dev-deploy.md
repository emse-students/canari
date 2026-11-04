### Fixed - the dev deploy of `v1.6.4-alpha.1` failed on a `grep -q` under pipefail

`rolling.sh` matched the large `nginx -T` dump with `printf | grep -q`, which fails under `pipefail` exactly when the line is found; it and every other such pipeline in the shell scripts are now herestring or file reads, and `pipefail-early-reader.test.mjs` refuses a new one ([durable-rules](docs/wiki/durable-rules.md#release-and-ci---cicd)).
