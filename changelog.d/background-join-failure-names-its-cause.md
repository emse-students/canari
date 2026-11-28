### Fixed - a background join that fails now says why, and a refused write is no longer an error

The native Welcome join answers a typed cause instead of a bare false, and `NOT_YET` of the background
send is logged as the expected state it is. See [mobile](docs/wiki/frontend/mobile.md#the-background-join-says-why-it-failed-owners-log-of-2026-11-27-184).
