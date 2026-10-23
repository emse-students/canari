### Security - three retired `cargo audit` ignores deleted from the Tauri app

`quick-xml` now resolves to a fixed version and `rkyv` has left the lockfile, so their three
advisory ids no longer silence anything and would only hide a return. See [cicd](docs/wiki/cicd.md).
