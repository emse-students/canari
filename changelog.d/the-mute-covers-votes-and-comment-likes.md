### Fixed - a muted account can no longer vote in a poll or like a comment

`votePoll` and `likeComment` now refuse a muted caller first, like every other participating route
([moderation-authority](docs/wiki/moderation-authority.md#sanctions)).
