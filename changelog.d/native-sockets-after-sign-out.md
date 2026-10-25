### Fixed - a login that failed no longer leaves a gateway socket alive after the sign-out

Destroying an MLS client now releases its socket and fences any open still in flight, so a failed login's handshake can no longer keep the device online as an account that has signed out ([auth](docs/wiki/frontend/modules/auth.md#a-destroyed-client-keeps-no-socket-and-none-lands-on-it-later-2026-10-25)).
