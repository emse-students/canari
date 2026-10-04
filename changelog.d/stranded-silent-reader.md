### Fix - a device holding a group it was never welcomed into repairs itself without sending

The groups list now carries this device's own seat, and the sync loop hands a stranded one to the existing roster repair. See [mls-recovery-ladder](docs/wiki/protocols/mls-recovery-ladder.md#a-silent-reader-is-handed-to-the-roster-repair-by-the-groups-list).
