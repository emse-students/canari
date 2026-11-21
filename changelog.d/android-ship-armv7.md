### Fixed - 32-bit Android phones can install Canari again

The Android build compiled `arm64-v8a` only, so Play refused every 32-bit device (a Galaxy A11, for
one) and its APK said "not compatible". The build now names `aarch64` and `armv7`, and the pipeline
fails when either ABI is missing from the AAB or the APK
([mobile](docs/wiki/frontend/mobile.md#the-release-names-its-abis-and-a-32-bit-phone-was-lost-without-a-word-2026-11-21)).
