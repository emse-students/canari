## P3 - the comment route accepts a comment with no text and no media, and pushes "Nouveau commentaire"

target: 1.8.0

**Seen 2026-11-15 on dev.** `POST /api/posts/:id/comments` with a body carrying neither `text` nor
`media` (a misnamed field, `content`) answered 201 and stored a comment whose `text` is `''`
(`addComment` writes `data.text ?? ''`): the post's author was pushed "Canari Test Delta a commenté /
Nouveau commentaire", and the sheet drew an author with an empty bubble. The client never sends one,
but the route is the gate: refuse a comment with no text and no media with a typed 400 at the DTO,
and pin it in the comment-write spec.
