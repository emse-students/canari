### Fixed - an iOS release build died on a lint level the Rust setup action exported

Pinning `setup-rust-toolchain` (#3440) moved it to v2, which exports `CARGO_BUILD_WARNINGS=deny` to every later step of the job. `1.6.12-alpha.1`'s iOS build then refused the vendored `wry` patch's upstream warnings. Both exported inputs are now held empty, and `action-pins.test.mjs` asserts it ([cicd](docs/wiki/cicd.md)).
