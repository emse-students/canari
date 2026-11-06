### Added - the deploy log counts the connection resets a service logged during a release

`rolling.sh` reads each retiring replica's log before removing it and, once the last service is replaced, every running container of the replaced services, then prints one `[TRANSPORT_RESETS]` line per container and a deploy-wide total; an unreadable log reads `unknown`, never zero. The proxy for service-to-service calls waits for these readings ([backlog](docs/wiki/backlog.d/p2-service-to-service-calls-bypass-the-rotation.md)).
