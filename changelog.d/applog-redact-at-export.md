### Fixed - an exported log no longer carries messages an older build stored in clear

The in-app log was redacted only when a line was written, so lines stored before #1839 (`text="bisous"`) left the device as they were; every stored line now passes the same, now idempotent, redaction again when it is read for export (in batches that yield to the main thread), and the `[SEND]` lines JSON-quote the text so a typed `"` no longer lets the rest of a message through ([mobile](docs/wiki/frontend/mobile.md#redacted-at-write-and-at-read)).
