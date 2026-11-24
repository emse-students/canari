## Reading owed - a catch-up lands in the open conversation in one render and keeps its end (Mi 9T)

target: 1.8.0

Built: a bulk-ingest window now holds an own message decrypted from a frame (this account's other
device) and a push-preview upgrade, so a drain changes the open conversation once, at its close; the
"Réception des messages en attente..." banner is raised from the buffer of any open window and
lowered by its close; `[QUEUE] Drain complete: N frame(s) in T ms` is INFO
([chat](../frontend/modules/chat.md#a-catch-up-lands-in-one-render-2026-11-24)).

The reading: on the Mi 9T, leave a DM open, put the app away, send ~100 messages into it from the
peer AND from this account's other device (with a few reactions), come back. It passes when the pane
is at the end once the drain closes, the exported log holds no `left the bottom with no finger on the
pane` during the drain, the banner showed and went away with the close, and the `Drain complete` line
gives the total time (expected about half of the ~10 s measured on `1.7.3` for 148 frames). Then
the same with the reader SCROLLED UP in the thread before leaving, and the catch-up ending with a
message from the other device: the pane must stay where the reader left it (`ownMessageAppended`
follows only a message composed here), with the unread pill for what arrived below.
