### Fixed - a post naming a malformed association or form id is refused with a 400

`POST /api/posts` validates `associationId` and `attachedFormId` as uuids at the input check, so such a request is answered 400 and no longer reaches the database ([social-service](docs/wiki/services/social-service.md)).
