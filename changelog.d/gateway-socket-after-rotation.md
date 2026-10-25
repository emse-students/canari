### Fixed - the gateway socket now follows a device identity rotated during login

A login that re-enrolled a lost state kept its socket under the abandoned device id, so the new device got no realtime frames until the next reconnect; the rotation now reopens the socket under the new id, and the old id is retired only once no socket carries it ([auth](docs/wiki/frontend/modules/auth.md#the-device-id-is-not-final-when-the-handshake-starts-fixed-2026-10-25)).
