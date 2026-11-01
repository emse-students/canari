### Fixed - iPhone notification outcome log: no false `killed` after a clock change, no lost or torn line

A run's marker is now stamped with the boot session rather than the boot time, which moves when the clock is stepped; a run's line left beside a busy log is written under its own name before the marker goes; and a short append is cut back so no torn line remains ([mobile](docs/wiki/frontend/mobile.md#what-the-extension-did-in-the-apps-log-2026-11-01)).
