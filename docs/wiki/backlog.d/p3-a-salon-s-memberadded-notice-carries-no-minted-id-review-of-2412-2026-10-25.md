## P3 - A salon's `memberAdded` notice carries no minted id (review of #2412, 2026-10-25)

target: 1.9.0

`inviteMemberToChannel` (`useChannelWorkspaces.svelte.ts`) still sends its `memberAdded` through
`mkSystem`, with no `messageId`, while every group notice uses `mkVisibleSystem` since the
notice-identity fix ([chat](../frontend/modules/chat.md#a-visible-system-notice-needs-an-identity-the-sender-minted)).
A salon row is server-authoritative, so the history exchange this PR is about does not reach it; what
an id-less notice costs there (a duplicate on a replay or a re-fetch) is unmeasured. Not built.

Re-read 2026-11-11 (batch 12): still real - the salon invite still sends `mkSystem('memberAdded', ...)` with no id. Re-read again 2026-12-11.
