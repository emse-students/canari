### Added - the deploy log counts the connection resets a retiring replica saw

`rolling.sh` reads each retiring replica's log before removing it and prints `[S2S_RESETS] service=<name> retiring=<n> staying=<n>`; an unreadable log reads `unknown`, never zero. The proxy for service-to-service calls waits for these readings ([backlog](docs/wiki/backlog.d/p2-service-to-service-calls-bypass-the-rotation.md)).
