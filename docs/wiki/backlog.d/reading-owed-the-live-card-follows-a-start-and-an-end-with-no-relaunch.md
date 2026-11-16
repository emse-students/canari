## Reading owed: the feed's live card follows a start and an end with no relaunch (1.7.0-alpha.6 oddities)

target: 1.7.0

On a pre-release with this fix, two seats: a broadcaster and a follower sitting on the top of the feed.
Start a live: the follower's card (or carousel, with two lives) appears with no relaunch within one
preview period. End it: the card goes. Also hide the follower's tab, end the live, bring the tab back: the
card is gone at once. Mechanism and tests: [live](../frontend/modules/live.md#the-feed-card-follows-the-live-2026-11-16).
