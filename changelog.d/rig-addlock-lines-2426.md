### Changed - the rig reads #2426's add-lock lines, and tells an owed release from a slow Add

A refused acquire in its `retryAfterMs=<n>` shape is routine like the `ttl=` one; a `[RELEASE_LOCK] ... released=false ... owed=true` (a revived page releasing its dead predecessor's expired lock) is expected, while the unflagged `released=false` stays notable as a slow Add, and malformed flags stay unexplained. The member-panel backlog item is re-graded P2 on its second sighting ([backlog](docs/wiki/backlog.md)).
