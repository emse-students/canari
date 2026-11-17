### Fixed - a new group's invitation is no longer refused by the creator's own other device

The pending-invitation sweep took a group's add lock before reading its rows, so the creator's other device, vouching for its siblings after the creation's Welcome, refused the creator's invitation and the group was created holding its creator alone; it now takes the lock only for an Add, and an invitation that adds nobody names everyone it invited ([chat](docs/wiki/frontend/modules/chat.md#nothing-of-the-creators-own-takes-the-add-lock-it-does-not-commit-under-2026-11-17)).
