### Fixed - the Linux CI dependency install survives an unreachable Ubuntu mirror, and one outbox test no longer reads a row mid-write

The Rust jobs' `apt-get` steps now retry and fall back to `archive.ubuntu.com` through `.github/scripts/apt-install.sh`, and the RC-13 "reach names only its own take" case waits for the encoder before reading. See [cicd](docs/wiki/cicd.md#notable-ci-gotchas).
