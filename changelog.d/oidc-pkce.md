### Security - the MiConnect sign-in carries PKCE

The client sends an S256 challenge, when `/api/version` says core-service can redeem it, and redeems its code with the matching verifier, kept in `sessionStorage` on the web; a callback that lands in another tab says so instead of failing on the server ([auth](docs/wiki/frontend/modules/auth.md#login-flow)).
