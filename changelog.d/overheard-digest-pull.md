### Fixed - a device that overhears a peer's history digest now asks for the messages it lacks

A browser saw its owner's phone list 7 message ids, held 6, and did nothing. It now pulls the missing ones from the digest's author ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md#a-digest-overheard-is-evidence-the-member-that-lacks-something-asks-its-author-2026-10-13)).
