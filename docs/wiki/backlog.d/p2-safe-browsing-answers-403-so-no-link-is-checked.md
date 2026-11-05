## P2 - Google Safe Browsing answers `403` to every lookup, so no link in the app is checked

Production on 2026-11-05 (`v1.6.5`, read-only `docker logs --since 72h` of chat-delivery):
- **Lookups.** 6 of 6 Safe Browsing lookups logged `[SAFE_BROWSING] lookup failed with status 403`,
  and none succeeded.
- **The key.** `GOOGLE_SAFE_BROWSING_API_KEY` is set, because otherwise the call would not run. Google
  refuses it, which means the API is not enabled on the key's Cloud project, the key is restricted to
  other APIs or to a referrer or IP, or the project has no quota.
- **What users see.** By design the check fails OPEN
  ([chat-delivery](../services/chat-delivery.md)). Every link therefore reads "not flagged", and the
  warning a user should get before opening a dangerous link never appears.

**Two halves:**

1. **The key (a one-off, the owner's).** In the Google Cloud console, open the project holding the key:
   - check that the "Safe Browsing API" is enabled;
   - check that the key's API restrictions include it;
   - check that the key has no referrer or IP restriction (the call comes from the server).

   Then read one `GET /api/mls/link-safety?url=<a known test URL>` on dev and look for the absence of
   the line.
2. **The report (code).** A `403` or a `400` is an ANSWER: the configuration is refused. It is not a
   transport failure, so it must not share the transient branch's `warn` and 5-minute retry.
   - Return a distinct refusal result from the non-2xx branch (`checkSafeBrowsing` returns a verdict, it
     does not throw), as a configuration refusal.
   - Log it at ERROR with the `error.status` and `error.message` from Google's JSON body (they name the
     cause).
   - Count it in the daily report, so a dead check is found the day it dies rather than by reading logs.

   A network error or a `5xx` keeps failing open, as designed.

**Closed when:** a production lookup succeeds (no `[SAFE_BROWSING]` refusal over a day with lookups), and
the refusal path has its ERROR line and its test.
