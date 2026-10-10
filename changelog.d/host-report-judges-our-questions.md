### Fixed - the daily host-update report no longer fails on the School's own apt policy

On the shared Portail-etu host the report was red every day on three facts nobody here may change (a wide origin list, an automatic reboot, an unreadable log). It now judges only what is ours there and prints the rest ([host-updates](docs/wiki/infrastructure/host-updates.md)).
