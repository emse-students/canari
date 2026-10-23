### Security - core-service redeems a MiConnect code with its PKCE verifier

core-service forwards a client's `code_verifier` to MiConnect and says so in `/api/version` (`oidcPkce`), so the client half can ship after it; it ships first and is never rolled back below this release ([legacy-compatibility](docs/wiki/legacy-compatibility.md#no-date-yet---an-oidc-callback-with-no-pkce-verifier)).
