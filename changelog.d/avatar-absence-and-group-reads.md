### Fixed - people without a photo are asked once, group photos draw at first render, duplicate group reads share one request

A 404 avatar is remembered for the server's own 10 minutes (it was re-asked 11-12 times per user), the group photo id is stored with the local conversation row, and simultaneous `groups/:id` and `user-members` reads join one request ([core-service](docs/wiki/services/core-service.md#an-absence-is-remembered-and-a-group-photo-is-stored-2026-10-05)).
