### Fixed - tapping a post, form or agenda notification on iPhone opens its target

The server sent only `postId` / `formId`, Android built the link itself and iOS opens nothing but `deepLink`; the push now carries it ([mobile](docs/wiki/frontend/mobile.md#what-each-notification-names-as-its-tap-target-and-who-routes-it-2026-10-05)).
