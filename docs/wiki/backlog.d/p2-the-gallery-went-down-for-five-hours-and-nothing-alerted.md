## P2 - the gallery (avatars) went down for five hours on 2026-11-05, nothing alerted, and every page asked it again

From about 11:35 to 16:30 UTC, `gallery.mitv.fr` answered Cloudflare `530` / `1033`: its tunnel had no
connector. The gallery runs on its own host, outside this estate. The effect, read only from production logs:

- **Canari:** about 2 000 `502`s per hour on `GET /api/users/<id>/avatar` in nginx's access log, and about 4 600
  `[AvatarService] Avatar unavailable ... ERR_BAD_RESPONSE` and `[AVATAR] outcome=unavailable` warnings
  per hour in core-service. The clients fell back to initials.
- **Le Cercle:** 602 `[MIGALLERY] Photo fetch ... answered HTTP 530` lines, growing with traffic.

Nothing told anyone. The owner heard it from users.

**Built 2026-11-06:** the report. The `upstream` job of `scheduled.yml` asks the gallery's health route from
outside and opens one issue per outage, naming the class, the status and since when
([upstream-reachability](../infrastructure/upstream-reachability.md)). It also covers the tunnel entry
([tunnel](p2-the-tunnel-connector-lost-every-connection-for-25-minutes.md)).

**Built 2026-11-07, Canari side:** no asking of a dependency known to be down. Durable state set by the failure
that proves it and cleared by the first answer, one probe at a time, one log line per transition
([upstream-reachability](../infrastructure/upstream-reachability.md#the-app-does-not-keep-asking-a-gallery-known-to-be-down-2026-11-07)).

**Owed (this entry closes when both are shipped):**

1. **Le Cercle's `[MIGALLERY]` photo fetch: the same mechanism is built as a draft merge request in its own
   repository (rootz/le-cercle !33, 2026-11-07); owed its merge and release.** Keep its `upstream-health.ts` in
   step with Canari's.
2. **One reading of the report on a real failure**, or the drill the wiki page describes, to see an issue open
   and close; and one reading of core-service's `is DOWN` / `is back` lines on a real outage.
