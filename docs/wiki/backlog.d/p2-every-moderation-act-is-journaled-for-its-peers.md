## P2 - no moderator sees what the other moderators of the same place did

target: 1.8.6

**Owner, 2026-11-15** ([moderation-authority](../moderation-authority.md#the-journal-and-the-notice),
decision 13): asked whether every act - hide, delete, unmask, a moderation read, a mute - should
leave a trace visible to *"les autres moderateurs du meme lieu (BDE, bureau, institution)"* and to
the platform admin, the owner answered *"Oui, visible des pairs"*. The owner's framing: *"Canari repose aussi sur les bons
usages, et des gens qui n'abusent pas de leurs permissions"* - visibility rather than walls.

**Today** an act leaves a server log line (`[MODERATION]`, `[MUTE]`, `[LIVE]`) read by nobody in the
app, and the state it changed (a hidden flag, a mute row's `mutedBy`). A mute row keeps only its last
writer, and a moderation read (#3561) logs a line.

**The change.**

- ONE append-only table in social-service (a plain additive migration), one row per act: the act's
  kind, the target (content kind and id, or person), the PLACE it was taken for (the BDE, association
  or institution whose authority it used, or `platform`), the actor, the reason when given, the time.
  Written in the same transaction as the act wherever the act is a database write, by ONE helper every
  act calls - a moderation read too, where #3561 now logs.
- Peers (the lead's reading, reversible): a row is listed to the members holding the same authority over the same place - the BDE's
  `MODERATE` members for a BDE act, the bureau (`POST_AS_ASSO` holders) for a place owner's act
  (a comment hidden under its post, a live ended or a line hidden by a co-holder), the institution's
  `MODERATE` members for its IM's act - and to every platform admin. Read through
  `GET /api/moderation/journal`, filtered by the same predicates that scope the queue; the client
  draws it as a tab of the moderation page.
- The actor IS named to peers (that is the point: peers see who did what); the target person is named
  only as the queue already names them. The notice to the person themselves never names the actor
  ([its entry](p2-a-moderated-person-is-told-which-place-acted.md)).
- Retention (the lead's reading, reversible): the reports' policy (90 days after the act), by the same weekly cron, written on
  [moderation-and-blocking](../moderation-and-blocking.md#retention-one-policy-one-place) and in the
  GDPR register ([register-of-processing](../compliance/register-of-processing.md)) - a new
  processing of personal data, so both change in the same pull request.

**Proof.** A spec per act kind that the act writes exactly one row in its transaction (a failed act
writes none); a PostgreSQL spec of the journal's scope (a BDE moderator sees its BDE's rows and not
another BDE's; a holder sees its bureau's; the platform admin sees all); an assertion that every route
guarded by a moderation predicate calls the journal helper (a list of routes, so a new act cannot
forget it). The `[JOURNAL]` rows of the
[grid spec](the-moderation-authority-grid-is-asserted-by-table-driven-specs.md).
