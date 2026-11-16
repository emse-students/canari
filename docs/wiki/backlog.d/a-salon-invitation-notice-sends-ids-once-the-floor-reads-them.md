## P3 - A salon invitation's notice sends ids once the floor reads them (2026-11-16)

target: 1.8.0

The reader of `{ "newUsers": [id] }` ships in `1.7.0` (`channelSystemEnvelope`); the writer is held
behind `CHANNEL_NOTICE_IDS_WRITER_ENABLED = false`, because a build older than the reader would draw
the id shape as raw JSON text
([legacy-compatibility](../legacy-compatibility.md#removal-once-minclientversion-passes-170---a-salon-invitation-notice-sent-as-a-sentence-2026-11-16)).

**When:** `minClientVersion` reads `1.7.0` or above on BOTH estates (`GET /api/version`), raised under
the floor rule once both stores serve `1.7.0`.

**The change:** flip the switch, then delete it, the sentence branch of `channelMemberAddedData` and
its test, and the legacy-compatibility entry.

**The reading that closes it:** on dev, an admin invites account B into a salon; account C, set to
the other language than the admin, reads "X a ajoute B" / "X added B" with live names, centred, on the
live frame AND after a reload; neither unread nor a ring. Any raw `{"newUsers"...}` text is a FAIL.
