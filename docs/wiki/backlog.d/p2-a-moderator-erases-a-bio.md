## P2 - an offensive bio can only end in a mute, which leaves the bio up

target: 1.9.0

**Owner, 2026-11-15** ([moderation-authority](../moderation-authority.md#people-profile-mute-community-nicknames),
decision 16, *"Effacement par l'admin et le BDE"*): a bio is ERASED, never rewritten, by the platform
admin and the BDE in scope (a person of its spaces); the person is told and the act is journaled.

**Today** `PATCH /users/me` (`apps/core-service/src/users/dto/user.dto.ts`) is the bio's only writer;
the platform admin's profile edit (`profile-edit.service.ts`) does not cover it; a `user` report can end
only in a mute.

**The change.**

- A core-service route that empties a user's bio (no body but a reason): the platform admin through
  `GlobalAdminGuard`; a BDE moderator only when social-service answers that the caller moderates that
  person - the one predicate, `mayModerateUser` (`bdeModeratesUserSql`), asked over the existing
  internal channel with the internal secret, never re-implemented in core-service. Never a rewrite: the
  route takes no text.
- The act is journaled ([the journal](p2-every-moderation-act-is-journaled-for-its-peers.md)) and the
  person is told which place acted and why ([the notice](p2-a-moderated-person-is-told-which-place-acted.md)).
- From the reports queue, a `user` report offers "Effacer la bio" beside the mute; the act reviews the
  report.

**Proof.** A core-service spec: the platform admin erases; a BDE moderator of a space of the person
erases, one out of scope gets a typed 403; the route rejects any text; the profile reads an empty bio
afterwards. A social-service spec of the internal answer on the real predicate. The `[BIO]` rows of
the [grid spec](the-moderation-authority-grid-is-asserted-by-table-driven-specs.md).
