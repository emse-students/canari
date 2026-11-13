## Reading owed - acknowledging a conversation from the notification shade

target: 1.7.0

**What is built:** acknowledging a conversation from the notification shade (NOTIF-6b)

**The reading that closes it:** HARDWARE, both platforms: on A1 send from W1, background the app, tap **Marquer comme lu**, OPEN the app - the badge must be gone; then the same with a quick REPLY. `logcat` shows `sendReadWatermark: queued+drained at=<ms>` with the SENDER's instant, never near `now`
