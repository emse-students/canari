### Fixed - a malformed association id in a path is answered 400, before any guard reads it

A controller now declares what each path parameter is (`@RouteParams`) and one global guard checks it before every other guard; `AssociationsController` is the first converted ([social-service](docs/wiki/services/social-service.md#path-parameters-are-declared-and-one-global-guard-reads-the-declaration-2026-11-14)).
