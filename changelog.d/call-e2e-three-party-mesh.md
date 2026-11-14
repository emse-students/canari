### Added - a 3-party encrypted mesh call in CI

The call-service end-to-end job also runs `--scenario mesh`: three browsers, one key per sender, every directed leg proven decrypted, a fourth user refused past the signed cap, and a wrong key shown to fail its leg ([call-service](docs/wiki/services/call-service.md#the-mesh-scenario-wp-gc2-2026-11-13)).
