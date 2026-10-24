### Security - the Alumni SAML source stays disabled until its verification certificate exists

MiConnect's Alumni SAML source ships disabled in the blueprint until the identity provider's verification certificate is imported and attached as its verification key pair, and the blueprint suite now gates it: no SAML source may be enabled without a verification key pair, and none may run an unsigned, weakly-signed (SHA-1/MD5) or IdP-initiated configuration. See [authentik](docs/wiki/infrastructure/authentik.md#the-alumni-saml-source-what-to-hand-the-idp-and-what-is-still-missing-2026-10-22).
