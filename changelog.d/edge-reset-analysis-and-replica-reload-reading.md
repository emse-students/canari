### Fixed - the chat-gateway reads the client's Close after `disconnect`, so the edge logs no reset

On `disconnect` the gateway now leaves routing at once and ends the socket on the client's Close; dropping it first had the frontend's nginx reset the connection, three times at the edge on 2026-11-13 - not a keepalive race ([chat-gateway](docs/wiki/services/chat-gateway.md#disconnect-ends-the-session-at-once-and-the-socket-on-the-clients-close-2026-11-14)).
The replica-reload reading closed in production on `v1.6.12` ([cicd](docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to)); media-service's root-owned volumes measured and the non-root plan written ([backlog](docs/wiki/backlog.d/p3-two-service-images-still-run-as-root.md)).
