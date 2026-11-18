## P2 - a message with two plural selectors shows its key: "post_attachments_partial" in a toast

target: 1.7.1

**Found by:** the toast-over-an-overlay reading, sitting S6 on `1.7.0-alpha.12` ([readings](../device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning)). On the Mi 9T, a
drop of eleven images on a new-post composer already holding one raised a toast reading **"post_attachments_partial"**
instead of "10 ajoutées, 2 laissées de côté : ...".

**Cause, read in the compiled output:** the four messages of `messages/fr.json` and `en.json` that declare TWO
selectors - `post_attachments_partial`, `profile_backup_import_ok`, `profile_backup_import_ok_other_device`,
`reel_sendto_delete_everywhere_skipped` - write their match keys as `"takenPlural=one leftPlural=one"`. The
Paraglide compiler reads that as ONE selector whose value is `"one leftPlural"` (the JSDoc table of
`src/lib/paraglide/messages/post_attachments_partial.js` lists `"one leftPlural"` and `"other leftPlural"`), so
no branch ever matches and the function returns its own key. Every caller of the four shows the key. Not a
regression: the four messages and their key syntax are the same at `v1.6.12`.

**The fix:** the match-key syntax the message-format plugin expects for two selectors, and a test that
compiles each multi-selector message for every plural pair and asserts the output is not the key (no test
renders these four today).
