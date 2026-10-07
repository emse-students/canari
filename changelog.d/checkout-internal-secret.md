### Fixed - a paid form or product could not start a payment

social-service reaches core-service past nginx, and core still asked for nginx's `X-User-Id`: every checkout answered 400 `Missing X-User-Id header`. Both routes now check the internal secret and the caller sends it ([core-service](docs/wiki/services/core-service.md)).
