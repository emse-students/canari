### Fixed - after an offline start, the communities came back only at the next foreground

Tauri's HTTP client rejects with a bare string, which was read as a final answer. It is now typed at the throw as a transport failure. The reconnect lists the communities again, and salon sends wait instead of being refused ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md#14-a-transport-failure-is-one-type-on-every-platform-2026-10-14)).
