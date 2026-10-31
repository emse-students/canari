### Changed - a member's further device lets itself in when no member device is online

A member's new device still asks first, and joins by itself when the server says nobody can answer.
It is announced as an ordinary added device, and its history follows rule 2. A conversation that can
never be opened on a device says so, decided only by server facts, with "Recommencer avec les mêmes
personnes" ([mls-availability-no-holder](docs/wiki/protocols/mls-availability-no-holder.md#decisions-taken-2026-10-31)).
