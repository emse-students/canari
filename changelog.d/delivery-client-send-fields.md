### Changed - chat-delivery: client sends and commits are checked against their caller

`POST /mls/send` accepts the fields a client sends, a `proto`, and the caller as its sender, from a
device of its own that is a member of the group. The pre-MLS content path is removed
([legacy-compatibility](../docs/wiki/legacy-compatibility.md#removed-2026-10-22---the-pre-mls-send-path-the-content-column-and-its-read-arm-wait-for-a-migration)).
`POST /mls/commit` binds the committer and its device to the caller and requires a member of the
group, or for an external commit a person on its roster; its fan-out skips only devices new to the
group. A device id belongs to one account. A key group's external join is not gated yet
([backlog](../docs/wiki/backlog.md#p1---wp-keygroup-join-gate-a-key-group-external-join-has-no-entitlement-gate-yet-2026-10-22)).
