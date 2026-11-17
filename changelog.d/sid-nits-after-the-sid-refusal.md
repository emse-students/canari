### Changed - a push registration naming no session is refused, and the device panel's removal messages are tested

Since verify answers a token without `sid` as anonymous, `POST /mls/push/register` refuses a request naming no session (`400 SESSION_UNNAMED`) instead of writing a NULL binding; the panel shows a removal's message after its reload through one tested step ([sessions](docs/wiki/sessions.md)).
