### Fixed - the smoke sign-in's terms answer was refused as a CSRF failure

`v1.7.1-alpha.2`'s dev deploy reached the terms prompt and got an HTTP 500: once the session is signed in, MiConnect's CSRF check refuses a POST carrying neither `Origin` nor `Referer`. Every answer now carries the IdP as `Origin` and the flow page as `Referer`, as a browser does, and the test's fake IdP refuses them otherwise ([cicd](docs/wiki/cicd.md#the-smoke-sign-in-wp-smoke-login-decided-2026-10-18)).
