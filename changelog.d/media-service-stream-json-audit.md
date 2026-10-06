### Fixed - the dependency audit is green again: two more stream-json advisories are ignored on an asserted premise

`GHSA-hqr4-qq8f-hg3x` and `GHSA-mjw6-4jj6-33hc` reach media-service only through `minio > stream-json`, and minio imports nothing but `stream-json/jsonl/Parser.js`; that premise is now an allowlist asserted by `stream-json-premise.sh` and its self-test. See [backlog](docs/wiki/backlog.md).
