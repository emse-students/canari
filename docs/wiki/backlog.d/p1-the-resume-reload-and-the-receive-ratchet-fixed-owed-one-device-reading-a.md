## Reading owed - the resume reload and the send-side rewind on the Mi 9T

target: 1.7.0

Defects A (#435, `v0.16.6`) and B (#1527, the native reload refuses `live-ahead`) are shipped; mechanism in [mls-desync-prevention](../protocols/mls-desync-prevention.md#the-resume-reload-re-installed-a-receive-ratchet-behind-the-live-one---the-2026-09-08-captures-mi-9t). **Owed on the Mi 9T:** (1) resume right after a received frame with no checkpoint between and read `[MLS][Tauri] Resume reload SKIPPED`; (2) re-measure the `E/` pair (a duplicate `recevoir_messages_batch` 83 ms apart) on a rebuilt APK (`adb logcat -v time` during NOTIF-7); (3) reproduce the 2026-09-06 SEND-side rewind from the phone. **Do not await the outbound checkpoint** ([why](../protocols/mls-desync-prevention.md#the-checkpoint-window-and-the-per-document-snapshot-counter-moved-from-the-backlog-2026-10-08)).
