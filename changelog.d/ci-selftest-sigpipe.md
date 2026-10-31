### Fixed - a CI self-test that failed at random

`grep | grep -q` and `| head` under `set -o pipefail` died of SIGPIPE whenever the reader quit first (`local-copy-guards.test.sh` printed "Broken pipe" then failed). The sibling self-tests now drain the pipe: `grep ... >/dev/null`, `sed -n 1p` ([cicd](docs/wiki/cicd.md)).
