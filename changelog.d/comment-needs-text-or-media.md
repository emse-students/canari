### Fixed - a comment with neither text nor media is refused with a 400

The comment route stored a body carrying neither (a misnamed field) as an empty comment and pushed
"Nouveau commentaire" to the post's author. The DTO now refuses it, typed by its constraint name
([social](docs/wiki/services/social-service.md)).
