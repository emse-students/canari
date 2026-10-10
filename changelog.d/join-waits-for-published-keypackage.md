### Fixed - a join waits for the server's statement that the device has a KeyPackage, and the round's requests can no longer hang it

The external join of a key group now waits on the published fact (the row the commit gate reads) rather than on a round that may not have started, and every HTTP call of the key package round has a typed deadline. Design, measurements and the one clock in [campaign-measured-defects](docs/wiki/protocols/campaign-measured-defects.md#a-new-devices-join-reaches-the-commit-gate-before-its-keypackage-2026-10-09).
