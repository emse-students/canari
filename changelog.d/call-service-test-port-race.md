### Fixed - the call-service signalling tests no longer collide on a port when run in parallel

Each test's service now binds port 0 itself and reports the port it got, instead of reusing one the test had already released ([call-service](docs/wiki/services/call-service.md)).
