### Fixed - a direct-message notification names its sender once

On Android 11+ the system titles a conversation notification with its shortcut, so a direct message in the group shape showed the name in the header and again above the line; it now takes the one-to-one shape there, and the reader's own inline reply stays named. On Android and iOS, an unreadable direct message now reads "Nouveau message" under the sender, and a group with no name is told apart from a DM by the server's `isGroup` and titled "Conversation de groupe" ([mobile](docs/wiki/frontend/mobile.md)).
