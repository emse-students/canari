### Changed - a post with several documents shows compact rows, and a post holds at most ten attachments

From two documents on, a post lists them as rows (icon, name, size, download) with no preview, and
the file is fetched only when tapped; one document keeps its preview. Past ten attachments the
composer stops adding and says how many were left out, and the server refuses with
`POST_ATTACHMENTS_TOO_MANY`. See [posts](docs/wiki/frontend/modules/posts.md).
