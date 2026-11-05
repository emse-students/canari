## P2 - the gallery (avatars) went down for five hours on 2026-11-05, nothing alerted, and every page asked it again

From about 11:35 to 16:30 UTC, `gallery.mitv.fr` answered Cloudflare `530` / `1033`: its tunnel had no
connector. The gallery runs on its own host, outside this estate. The effect, read only from production logs:

- **Canari:** about 2 000 `502`s per hour on `GET /api/users/<id>/avatar` in nginx's access log, and about 4 600
  `[AvatarService] Avatar unavailable ... ERR_BAD_RESPONSE` and `[AVATAR] outcome=unavailable` warnings
  per hour in core-service. The clients fell back to initials.
- **Le Cercle:** 602 `[MIGALLERY] Photo fetch ... answered HTTP 530` lines, growing with traffic.

Nothing told anyone. The owner heard it from users.

**Owed:**

1. **A report.** It names the gallery as unreachable from the first failure, with its status and since
   when. This is the same gap as the canari box's tunnel loss
   ([tunnel](p2-the-tunnel-connector-lost-every-connection-for-25-minutes.md)), so build ONE
   upstream-reachability report covering both.
2. **No asking of a dependency already known to be down.** Today every avatar request goes to the gallery
   and logs again. The fix is not a timeout. The fix is durable state that says the gallery is down,
   written by the failure that proves it and cleared by the first success:
   - while that state is set, one probe at a time asks the gallery, and every other request answers
     from the state;
   - the log line becomes one transition ("down since", "back after") and no longer one line per
     avatar.

   Le Cercle's `[MIGALLERY]` fetch needs the same treatment, in its own repository.
