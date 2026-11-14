### Fixed - a post naming a malformed association id is refused with a 400

`POST /api/posts` validates `associationId` as a uuid at the input check, like a comment's, so the request is answered 400 and no longer reaches the database ([social-service](docs/wiki/services/social-service.md)).
