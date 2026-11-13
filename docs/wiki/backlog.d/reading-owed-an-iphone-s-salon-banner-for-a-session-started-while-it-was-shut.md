## Reading owed - an iPhone's salon banner for a session started while it was shut

target: 1.7.0

**What is built:** an iPhone's salon banner for a session started while it was shut (NOTIF-20's NSE half): a silent `keyMaterial` frame never wakes the NSE, so the seed can only come from the frame the salon push itself carries - proved on Android, never on an iPhone ([channel-encryption section 19](../protocols/channel-encryption.md#19-design-the-seed-travels-with-the-message---decided-by-the-user-2026-09-27))

**The reading that closes it:** the iPhone 12 KILLED, a member opens a NEW session in a salon (a seed the phone never held) and sends one text: the banner shows the text, and chat-delivery's `[PUSH_BLIND] platform=ios` count does not move. A fail hands the owner one decision: an alert push for key material
