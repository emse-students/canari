### Fixed - a group being created is no longer discovered as a placeholder, or recovered, by the device creating it

The connection sweeps read the creation's own mark instead of taking the listed, still-rowless group for one this device lost; the window predates `1.7.0-alpha.3` ([chat](docs/wiki/frontend/modules/chat.md#between-the-registration-and-the-row-a-creating-group-looked-lost-to-the-connection-sweeps-2026-11-16)).
