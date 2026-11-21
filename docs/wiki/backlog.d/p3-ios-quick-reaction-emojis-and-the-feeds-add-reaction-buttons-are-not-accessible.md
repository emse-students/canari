## P3 - accessibility: iOS quick-reaction emojis in the long-press menu are absent from the accessibility tree, and the feed's "Add reaction" buttons are 1 pt wide (S17, 2026-11-20)

target: 1.8.0

Read on the iPhone 12, sitting S17 of 2026-11-20: the quick-reaction emojis of the message long-press menu do not appear in the accessibility tree (VoiceOver and the automation rig cannot reach them), and the feed's "Add reaction" buttons measure 1 pt wide, so they cannot be targeted either. Give each a role, a label and a real hit area (the post card is in [posts](../frontend/modules/posts.md)). Verify with a VoiceOver pass and the rig's accessibility dump.
