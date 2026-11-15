## Reading owed - a push carries its ciphertext once, not twice

target: 1.7.0

**What is built:** a push carries its ciphertext once, not twice

**The reading that closes it:** HARDWARE, both platforms, iOS the riskier half ([chat-delivery](../services/chat-delivery.md#transport--single-gateway-fcm))

**Triage 2026-11-14: Mi 9T about 10 min (one push, the FCM data in logcat carries one ciphertext key), iPhone about 10 min (the NSE line in the syslog).**

**iPhone 12 half, READ 2026-11-15 on dev (TestFlight `1.6.12-alpha.2`, build `100601202`, app killed):** an 1800-character DM from the delta web seat queued a 3296-byte ciphertext (`queued_message.proto`, read-only select on dev), twice what a doubled payload could carry under FCM's 4096-byte limit. chat-delivery logged `pushed=1` and no `[PUSH_SIZE]` refusal; the NSE logged `didReceive type=message`, then `outcome=decrypted ... stage=attach` 43 ms later, and dev's access log holds NO `/api/mls/push/fetch-proto` request in that window, so the ciphertext travelled inline once. The banner read the sender and the text. **Left: the Mi 9T half.**
