## Reading owed - a DM opens at its end in one render: no yank, no arrow at the end, one day pill

target: 1.8.3

_2026-11-27: moved to 1.8.3 when 1.8.2 shipped._

Built 2026-11-25 (`fix/thread-open-lands-once`): the entry's widen no longer glides nor writes
`scrollTop`, only an arrival glides, and a glide's end re-measures the pane
([chat](../frontend/modules/chat.md#an-open-lands-once-a-change-above-the-reader-never-glides-2026-11-25)).
The unit and component tests pin the decisions; happy-dom draws no frame.

The reading, on the Mi 9T (and the iPhone 12), on the first alpha carrying it: open a DM whose last
screen holds a voice note and an image or GIF, from the conversation list, three times, recording the
screen. **Passes when** no frame shows the thread above its end after the first one (no slide down),
the round down-arrow never shows while the last message is visible, and at most ONE day pill is drawn,
naming the day at the top of the view. The exported log should hold, per open, one
`[CHAT_VIEW] ... entry settled: pinned=true isNearBottom=true` and NO `left the bottom with no finger
on the pane` line; one that appears is the evidence the remaining cause owes.

**Read on the iPhone 12, `1.8.2-alpha.7` (2026-11-26): PARTIAL.** Three opens of a DM ending on two voice notes: one `entry settled: pinned=true isNearBottom=true newestVisible=true` each, no `left the bottom with no finger on the pane`, one day pill, no down-arrow in the tree. **Left:** "no frame shows the thread above its end", which needs the screen stream, and the Mi 9T.
