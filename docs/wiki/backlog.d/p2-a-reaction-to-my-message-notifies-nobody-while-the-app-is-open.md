## P2 - A reaction to my message notifies nobody while the app is open, on any screen (2026-11-17)

target: 1.7.1

**Reported by the owner, 2026-11-17** (Android, production): no notification when someone reacts to
one of his messages while the app is open. The push is dropped in the foreground, and nothing else
drew the reaction.

**Built and shipped in `1.7.0`** (#3792): the reaction frame is the second trigger a message has,
decided by `reactionNotification.ts` - mechanism, identity dedup and tests in
[mobile](../frontend/mobile.md#the-frame-trigger-of-a-reaction-2026-11-17). The server's
`[SOCIAL_PUSH] sent` lines carry `kind=` (`message_reaction`), so the sent count is one `grep`.

**Read PASS on `1.7.0-alpha.10`** ([2026-11-17](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha10-both-phones-and-the-rig),
[2026-11-18](../device-verification.md#the-phone-readings-of-2026-11-18-170-alpha10-the-iphone-broadcasting-and-reactions-in-a-group-a-salon-and-a-locked-iphone)):
a 1:1 and a group on the Mi 9T (feed, another conversation, the reacted conversation open, the
background), the iPhone 12 in another conversation, under Control Center and locked. The salon case
failed on the first reaction of a new seed session:
[its own entry](p2-a-salon-reaction-that-opens-its-sender-s-new-seed-session-is-never-notified-in-the-foreground.md),
built for `1.7.1`.

**The reading owed (on the next `1.7.1` pre-release): the web with its tab hidden.** A signed-in web
seat that GRANTED notifications (the rig seats report `denied`), its tab hidden, while another seat
reacts to a message it wrote in a 1:1: ONE browser notification, and none once the tab shows that
conversation.
