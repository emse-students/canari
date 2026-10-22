### Changed - chat-delivery: reporting a device `active` promotes an existing seat only

The one writer of an `active` membership now takes the authority each caller acts on. A REPORT
(`POST /mls/invitations/status`, `POST /mls/push/membership-active`) needs the device's own row in
that group, free of an unanswered kick, and in a conversation its owner on the roster; otherwise it
is refused as `NOT_A_MEMBER` and logged
([backlog](docs/wiki/backlog.md#note---a-kicked-devices-membership-report-2026-10-22)).
