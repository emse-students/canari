### Fixed - the nightly image scan was red on a curl advisory no upstream image fixes yet

`CVE-2026-92392` (curl 8.22.0) is in the four Alpine images production runs and none has a patched
build, so it is allowlisted by package and version and retires itself when the pins move ([cicd](docs/wiki/cicd.md#container-images-are-scanned-2026-10-23)).
