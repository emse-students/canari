## P3 - iOS: the notification extension takes an `EXC_GUARD` and about 47 sandbox denies at every wake (S17, 2026-11-20)

target: 1.7.3

Read on the iPhone 12, sitting S17 of 2026-11-20: the kernel logs `EXC_GUARD AST: type=0x1` for CanariNotifications at every wake, plus about 47 `Sandbox deny system-info vfs.disk-space`. **The push still decrypts**, so nothing is broken for the user, but a guard exception on every wake is the visible end of something upstream: find which descriptor or file the extension closes or reads that the guard protects, and which call asks for the disk space (a file-size or free-space query by a dependency). Explain it or remove the call. Context: [mobile](../frontend/mobile.md).
