### Fixed - a conversation restored over a group the device is out of waits on the server, and a group becoming ready is announced only into its own session

A kill could leave a conversation `active` over the state of a Remove that was the first half of a re-admission, and the next send retired it; the restore now drops that state and lets the server's answer decide. A Welcome or a join landing after a sign-out could resume the next session's outbox ([chat](docs/wiki/frontend/modules/chat.md#a-group-becoming-ready-resumes-what-was-held-for-it-and-a-re-admission-holds-2026-10-31)).
