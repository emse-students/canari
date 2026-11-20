### Fixed - a PIN request that hangs ends as "unreachable", and a 429 says "too many attempts"

PIN requests now live under the app's request deadline; a 429 reads "Trop d'essais" with the minute to retry at; the password sign-in link has a plain label ([auth](docs/wiki/frontend/modules/auth.md#pin-and-device-key)).
