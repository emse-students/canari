### Security - the MiConnect sign-in carries PKCE

The client sends an S256 challenge and redeems its code with the matching verifier, so an authorization code is bound to the device that asked for it ([auth](docs/wiki/frontend/modules/auth.md#login-flow)).
