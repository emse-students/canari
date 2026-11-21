### Changed - a pull request now compiles the Android app crate for 32-bit phones too

Releases ship `armeabi-v7a` since #3932, but the pull-request check built `aarch64` only, so an
armv7-only break would have surfaced at release. The `Compile Android app` job now also runs
`cargo check` for `armv7-linux-androideabi`
([cicd](docs/wiki/cicd.md)).
