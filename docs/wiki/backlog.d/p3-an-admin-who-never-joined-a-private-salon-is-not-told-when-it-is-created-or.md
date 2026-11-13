## P3 - an admin who never joined a private salon is not told when it is created or deleted

target: 1.9.0

Not on the roster, so no `channel.deleted`; the sidebar keeps a stale row until the next load. **Do not widen the audience** (that is what leaked private-salon traffic to non-members); the shape that would work is a contentless `channel.gone` addressed to the community, worth doing only if the stale row is ever seen to matter.

**The creation half (COMM-13 on `1.5.0-alpha.1`, 2026-10-27):** a private salon's creation is announced as `channel.member.joined` to its audience, which is `allowedUsers` alone, so an administrator who is online sees no "join as administrator" row until their next full listing - though [channel-encryption](../protocols/channel-encryption.md) intends that row to be visible to them. COMM-13's premise (the unjoined row on the admin's screen) therefore never arms on a live client; it passed on `0.16.3` (2026-09-05), and what brought the row to the admin then is not established. The same contentless shape (`channel.listed`, no name beyond what the listing already serves to a manager) would close both halves.
