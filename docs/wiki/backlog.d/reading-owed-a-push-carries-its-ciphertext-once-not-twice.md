## Reading owed - a push carries its ciphertext once, not twice

target: 1.7.0

**What is built:** a push carries its ciphertext once, not twice

**The reading that closes it:** HARDWARE, both platforms, iOS the riskier half ([chat-delivery](../services/chat-delivery.md#transport--single-gateway-fcm))

**Triage 2026-11-14: Mi 9T about 10 min (one push, the FCM data in logcat carries one ciphertext key), iPhone about 10 min (the NSE line in the syslog).**

**Mi 9T half, READ 2026-11-15 on dev (`1.6.12-alpha.2`, build `100601202`, app killed, beta web seat as the sender).** The phone's log names no FCM key, so the reading is the size the old shape could not deliver: a DM of 1 312 characters arrived INLINE (`hasInlineProto=true`, `decryptProto: success type=text chars=1312`, no fetch). By the sizes measured the same minute (a 2 114-character DM's proto was 3 716 base64 characters and went over the budget to `doFetchProto`), its proto is about 2.6 KB, so carried twice (`data` plus `apns`) the message would have been about 5.3 KB, over FCM's 4 096 B, and refused. It was delivered, so the Android token got the ciphertext once. **Left: the iPhone 12 half, about 10 min (the NSE line in the syslog).**
