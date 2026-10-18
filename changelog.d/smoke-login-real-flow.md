### Fixed - the dev smoke sign-in walks MiConnect's real flow

It died on its first live run (`HTTP 302`): it now follows authentik's post-stage redirect, encodes `next`, starts on `password-login` and names a CAS-only denial ([cicd](docs/wiki/cicd.md#the-smoke-sign-in-wp-smoke-login-decided-2026-10-18)).
