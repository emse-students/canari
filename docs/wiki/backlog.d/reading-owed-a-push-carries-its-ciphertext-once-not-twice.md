## Reading owed - a push carries its ciphertext once, not twice

target: 1.7.0

**What is built:** a push carries its ciphertext once, not twice

**The reading that closes it:** HARDWARE, both platforms, iOS the riskier half ([chat-delivery](../services/chat-delivery.md#transport--single-gateway-fcm))

**Triage 2026-11-14: Mi 9T about 10 min (one push, the FCM data in logcat carries one ciphertext key), iPhone about 10 min (the NSE line in the syslog).**
