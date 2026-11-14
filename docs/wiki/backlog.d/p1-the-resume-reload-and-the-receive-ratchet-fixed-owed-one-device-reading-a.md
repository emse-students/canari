## Reading owed - the resume reload and the send-side rewind on the Mi 9T

target: 1.7.0

Defects A (#435, `v0.16.6`) and B (#1527, the native reload refuses `live-ahead`) are shipped; mechanism in [mls-desync-prevention](../protocols/mls-desync-prevention.md#the-resume-reload-re-installed-a-receive-ratchet-behind-the-live-one---the-2026-09-08-captures-mi-9t). **Owed on the Mi 9T:** (1) resume right after a received frame with no checkpoint between and read `[MLS][Tauri] Resume reload SKIPPED`; (2) re-measure the `E/` pair (a duplicate `recevoir_messages_batch` 83 ms apart) on a rebuilt APK (`adb logcat -v time` during NOTIF-7); (3) reproduce the 2026-09-06 SEND-side rewind from the phone. **Do not await the outbound checkpoint** ([why](../protocols/mls-desync-prevention.md#the-checkpoint-window-and-the-per-document-snapshot-counter-moved-from-the-backlog-2026-10-08)).

**Read on the Mi 9T 2026-11-14 (`1.6.12-alpha.2`, dev, CDP console + logcat), three
background/resume cycles: 30 s away, under one second away, and a text sent 0.4 s before the
background.** Every resume logged `mls.bin reloaded on resume (C2)`, never `SKIPPED`, and that is the
expected answer today, not a miss: a send is followed by `Encrypted state checkpoint persisted` within
~150 ms, the background itself logs `flushing the encrypted checkpoint`, and the socket is RELEASED
while away (`[WS] Paused - disconnect sent`), so no frame is decrypted between the last checkpoint
and the reload. No rewind, no error line, the sent message reached the server (`[OUTBOX] ... sent`)
and the keypackage round after each resume minted nothing. **(1) and (3) are therefore not
provokable from the phone alone**; the native `live-ahead` refusal stays covered by `mls-core/tests/unsaved_ratchet_advance.rs`.
**Still owed: (2)**, the duplicate `recevoir_messages_batch` pair, which needs frames RECEIVED from a
peer during NOTIF-7 - a push sitting.
