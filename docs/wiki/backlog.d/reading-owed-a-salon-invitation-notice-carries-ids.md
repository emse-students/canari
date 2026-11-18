## Reading owed - a salon invitation's notice carries ids, drawn in the reader's language (2026-11-16)

target: 1.7.0

**What is built:** the inviter sends `{ "newUsers": [id] }` always; the localized sentence it sent
while a build older than the reader (`channelSystemEnvelope`, `1.7.0`) could still be admitted is
gone, with the floor raised to `1.7.0`
([legacy-compatibility](../legacy-compatibility.md#entries-170-retires-the-floor-raise-of-both-estates-once-both-stores-serve-170),
[chat](../frontend/modules/chat.md#a-salons-membership-notice-carries-ids-2026-11-16)). Proven by
`channelNotice.test.ts` and `useChannelWorkspaces.svelte.test.ts`; the reader by
`channelNotice.readers.test.ts`.

**The reading that closes it, on the first pre-release carrying it:** on dev, an admin invites account
B into a salon; account C, set to the other language than the admin, reads "X a ajoute B" / "X added
B" with live names, centred, on the live frame AND after a reload; neither unread nor a ring. Any raw
`{"newUsers"...}` text is a FAIL. An archive's older sentence notice still draws as it was written.
