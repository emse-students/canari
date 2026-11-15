### Fixed - media-service held no retention durations after the deploy that adds the relay, so conversation uploads were refused

Social-service's boot notice asked media-service to re-read through the mesh, which still routed to the retiring replica without the route (404). The notice now carries the two durations it read, and an empty media-service holds them ([retention-settings](docs/wiki/retention-settings.md)).
