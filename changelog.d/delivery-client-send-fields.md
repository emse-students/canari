### Changed - chat-delivery: client sends and commits are checked against their caller

`POST /mls/send` accepts the fields a client sends, a `proto`, and the caller as its sender with a
membership in the group. The pre-MLS content path is removed
([legacy-compatibility](../docs/wiki/legacy-compatibility.md#removed-2026-10-22---the-pre-mls-send-path-the-content-column-and-its-read-arm-wait-for-a-migration)).
`POST /mls/commit` takes the caller as its committer, and its fan-out skips only the devices the
commit admits.
