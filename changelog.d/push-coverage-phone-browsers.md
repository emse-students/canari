### Fixed - a phone id of no known format is accused by the daily push-coverage line, not dropped

The count already asks about the installed app's devices only; a phone-OS device whose id is neither
`tauri-` nor `web-` is now accused at WARN, and a test ties the two prefixes to the client
([chat-delivery](docs/wiki/services/chat-delivery.md#the-servers-row-decides-whether-a-registration-is-owed-2026-11-15)).
