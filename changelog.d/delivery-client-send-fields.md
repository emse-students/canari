### Changed - chat-delivery: client sends and commits are checked against their caller

`POST /mls/send` accepts the fields a client sends, a `proto`, and the caller as its sender, from a
device of its own that is a member of the group. The pre-MLS content path is removed
([legacy-compatibility](docs/wiki/legacy-compatibility.md#removed-2026-10-22---the-pre-mls-send-path-the-content-column-and-its-read-arm-wait-for-a-migration)).
A commit, foreground or background, is bound to its authenticated committer and that committer's
device, must come from a member (or, for an external commit, a person on the roster), and must name
its own group and base epoch; its fan-out skips only devices new to the group. A conversation's
Welcome reaches only a device of someone on its roster, and never ends a kick. A device id belongs
to one account ([backlog](docs/wiki/backlog.md#p1---wp-keygroup-join-gate-a-key-group-external-join-has-no-entitlement-gate-yet-2026-10-22)).
