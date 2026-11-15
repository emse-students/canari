## P3 - A channel invite sends a rendered sentence as the `memberAdded` frame data, which is not JSON: receivers draw nothing and the archive replay parses it bare (2026-11-14)

target: 1.7.0

`useChannelWorkspaces.svelte.ts` (the invitation's "notify the channel members" step) sends
`mkSystem('memberAdded', <sentence from chat_system_member_added>)`. Every consumer expects the data
to be JSON (`{ newUsers: [...] }`, the shape the group path sends through `sendVisibleNotice`):
the live handler (`setupMessageHandler.ts`) logs "carries unparseable data - handling it with none"
and draws no notice, and the archive replay (`historySystemEvents.ts`, `JSON.parse(parsed.system.data)`)
parses it with no guard. The sentence also freezes a display name into a frame, which the notice design
(ids on the wire, names drawn live) exists to avoid.

Fix: send the notice through `sendVisibleNotice` with `{ newUsers: [memberId] }`, so the channel gets
the same row as a group, names resolved at read time; decide at the same time whether the notice stays
`silent` (it must neither count as unread nor ring). Guard the replay's `JSON.parse` like the live path.
Tests: a channel invite sends JSON naming ids only; a replayed frame with unparseable data is skipped
with one line, never thrown.
