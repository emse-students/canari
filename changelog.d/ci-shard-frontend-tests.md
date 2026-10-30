### Changed - the frontend test suite runs as four parallel shards in CI

`vitest run` was 13.3 of the 14.9 minutes of the pull request critical path; it is now split four ways with `--shard`, and `CI passed` needs every shard ([cicd](docs/wiki/cicd.md)).
