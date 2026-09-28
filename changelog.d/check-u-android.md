### Fixed - after a failed biometric unlock, "use biometrics" on the PIN modal works again

A failed unlock no longer forgets who is signed in unless the session is dead, and an empty keystore
is a typed `mls-core` error rather than a sentence two call sites matched; the biometric cadence
passed check U on Android on the way
([backlog](docs/wiki/backlog.md#p2---after-a-failed-biometric-launch-unlock-the-pin-modals-biometric-button-does-nothing-measured-on-the-mi-9t-2026-09-28)).
