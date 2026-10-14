### Fixed - a group notification names the sender, not the group, on a conversation not yet opened

The in-app notification path read the sender's name from a cache that is empty until a conversation has been opened, so a group fell back to its own title (`NME`) on the sender line. The name is now fetched first, and a lookup that still fails is logged as a warning ([display names](docs/wiki/frontend/architecture.md)).
