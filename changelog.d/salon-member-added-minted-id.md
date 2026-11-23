### Fixed - a salon's "member added" notice carries a minted id

The salon invitation notice goes through `mkVisibleSystem` like every group notice, so a replay or a re-fetch can deduplicate it ([chat](docs/wiki/frontend/modules/chat.md#a-visible-system-notice-needs-an-identity-the-sender-minted)).
