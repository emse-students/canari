## P2 - a reported community nickname reaches a queue that cannot clear it, and a muted moderator still renames

target: 1.9.0

**Owner, 2026-11-15** ([moderation-authority](../moderation-authority.md), decision 6): a reported
community nickname goes to THAT community's moderators, the platform admin as recourse; a muted person
cannot set nicknames.

**Today.** A `nickname` report (`assertReportableNickname`,
`apps/social-service/src/moderation/moderation.service.ts`) is read by the platform admin only:
`reportInBdeScopeSql` (`spaces/bde-moderation.ts`) has no `nickname` branch, and no community moderator
sees the queue. Only a community moderator can clear a nickname (`mayWriteCommunityNickname`,
`channels/community-nicknames.ts`): the queue that sees the report cannot act, and the people who can
act never see it. `CommunityNicknamesService.set` reads no mute.

**The change.**

- The community moderators read the nickname reports of their community, on a route under the
  community gated by `memberCanModerate` - not under `/api/moderation/*`, whose door is the BDE's -
  listing the pending `nickname` reports whose member row belongs to that workspace, with the reported
  version's text while it is still shown.
- Clearing the nickname (the existing route) marks the pending reports on that version `reviewed`; a
  community moderator may also dismiss one. The platform admin keeps the global queue as recourse and
  gains the act it lacks: clearing a reported nickname from the queue.
- `set` refuses a muted actor with the mute's existing typed refusal, on anything but clearing their
  own nickname; the client words it from the code.

**Proof.** `community-nicknames.integration.spec.ts`: a muted moderator cannot name a member and can
clear their own; a community moderator lists and clears a reported nickname of their community and
not of another one; the clear reviews the report; the platform admin clears one from the queue. The
`[NICK]` rows of the [grid spec](the-moderation-authority-grid-is-asserted-by-table-driven-specs.md).
