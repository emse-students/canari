### Changed - a message page reads a page, and a drain writes the seen-frame ledger once

IndexedDB v11 and a SQLite index answer a page off `[conversation, timestamp]`; the live seen-frame mark is written with the checkpoint, and bubbles no longer each hold a window and a media-query listener ([performance-audit](docs/wiki/frontend/performance-audit-2026-10-12.md#findings-5-9-and-10---built-2026-10-17-draft-pr-perfpk13-message-storage)).
