### Fixed - chat-delivery-service no longer trusts the `x-user-logged-in` header alone outside production

With `INTERNAL_SHARED_SECRET` unset and `NODE_ENV` not `production`, the guard accepted any caller sending `x-user-logged-in: true` (CodeQL alert 2547). The signed `X-Internal-Token` and a non-empty `x-user-id` are now required in every environment, failing closed and loudly. Production and dev were already pinned to `production` with a secret, so nothing changed there. See [core-service](docs/wiki/services/core-service.md#three-services-refuse-an-unsigned-caller-three-different-ways).
