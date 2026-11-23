### Fixed - a comment with neither text nor media, or an edit to blank text, is refused with a 400

The comment route stored a body carrying neither (a misnamed field) as an empty comment and pushed
"Nouveau commentaire" to the post's author; the edit route accepted whitespace-only text. Both DTOs now
refuse them ([social-service](docs/wiki/services/social-service.md#posts-apiposts)).
