## P3 - a post naming a malformed association id answers 500

target: 1.7.0

Found 2026-11-14 on dev while staging the visibility readings: `POST /api/posts` with an
`associationId` that is not a uuid answers `500`, and social-service logs
`ERROR [ExceptionsHandler] QueryFailedError: invalid input syntax for type uuid`. A malformed id is
the client's error: it is refused `400` at the input check (`@IsUUID` on the DTO) and never reaches
Postgres, so the ERROR line - noise that hides a real one - disappears with it. A DTO spec sending a
non-uuid `associationId` pins it.
