### Fixed - the follower-tab seal test waits on the gate's call, not on one event-loop turn

`channelSeal.followerTab.test.ts` assumed one `setTimeout(0)` covers the payload's AES-GCM decrypt;
in a loaded CI shard it did not, and the late gate call failed the next test too (#3370's shard 3).
