### Fixed - a new device's join of a community key group no longer races its own KeyPackage publication

On a new device the community join could reach the commit gate before the KeyPackage did, so the gate refused the activation (`no_key_package`) and the device held a tree that routed nothing to it for up to hours; the join now waits for the key package round already running. Cause read from production and test in [campaign-measured-defects](docs/wiki/protocols/campaign-measured-defects.md#a-new-devices-join-reaches-the-commit-gate-before-its-keypackage-2026-10-09).
