### Fixed - `canari.emse.fr` served the wrong app since the estate move

Its vhost's `proxy_pass` still pointed at Portail-etu's port (`127.0.0.1:3000`); repointed to
Canari's (`127.0.0.1:8081`) and verified live. No DSI ticket was ever needed for this name. New
durable rule found in the process: a browser's local storage cannot follow a host change the way a
native app's can, so nothing may ever redirect an existing session between the two hosts
([estate-migration](docs/wiki/infrastructure/estate-migration.md#a-browser-cannot-follow-a-redirect-and-keep-its-state---there-must-never-be-one)).
