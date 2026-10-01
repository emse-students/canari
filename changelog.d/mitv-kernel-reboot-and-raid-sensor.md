### Fixed - `mitv` ran a kernel two months behind its security update, and nothing watched its RAID1

The reboot owed since 12 July was taken on 2026-09-03, and it exposed a `mdmonitor.service` that had refused to start on every boot; it now runs and its alarm was proven by a test event. The array still has no report that reaches a human ([host-updates](docs/wiki/infrastructure/host-updates.md#the-73-tb-raid1-nobody-was-watching-found-while-rebooting-for-the-kernel-2026-09-03)).
