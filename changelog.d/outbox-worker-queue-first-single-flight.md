### Fixed - Android: no false "messages en attente" alert, and a shade reply is never sent twice

The background retry worker looks at the outbox before counting attempts and no longer counts a
foreground deferral; the native outbox drain is single-flight
([mobile](docs/wiki/frontend/mobile.md#background-execution)).
