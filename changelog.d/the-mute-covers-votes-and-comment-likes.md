### Fixed - a muted account can no longer vote in a poll or like a comment, and sees both disabled

`votePoll` and `likeComment` refuse a muted caller first, like every other participating route, and
the served `canVote` / `canLikeComments` read the mute so the poll and the heart are drawn disabled
instead of refusing after a tap (a muted account can still take back a like it holds); a spec asserts every write route asks the mute or is exempt
([moderation-authority](docs/wiki/moderation-authority.md#sanctions)).
