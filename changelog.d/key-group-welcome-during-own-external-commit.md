### Fixed - a private salon granted right after joining a community could stay unreadable

A Welcome that arrived while this device's own join of the salon's key group was still awaiting the server's answer was taken for a duplicate and discarded; when the server then refused the join, the salon's keys could never arrive. The Welcome now waits for that answer ([channel-encryption](docs/wiki/protocols/channel-encryption.md#a-welcome-arriving-while-this-devices-own-external-commit-awaits-the-gate-was-thrown-away---fixed-2026-11-16)).
