### Fixed - A post id that is not a UUID is a 400, no longer a server 500

Every `:postId` route parses it first ([social-service](docs/wiki/services/social-service.md#posts-apiposts)).
