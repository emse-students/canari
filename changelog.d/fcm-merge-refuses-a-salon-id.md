### Fixed - the push cache merge refuses a salon id

`fcmMemoryMerge.ts` guards its own seam against a `channel_` conversation id; the two-ids-for-one-row case is an accepted risk recorded on the wiki ([chat](docs/wiki/frontend/modules/chat.md#a-visible-system-notice-needs-an-identity-the-sender-minted)).
