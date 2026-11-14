## Reading owed - the Android background send behind a captive portal

target: 1.7.0

**What is built:** the Android background send behind a captive portal (batch 11: `sendQueuedMessagePush` now keeps a message whose 2xx body is not JSON, or was lost in transport, instead of counting it sent - each logged as what it is, decided by `push/QueuedSendAnswer.kt` and its JVM test; `BackgroundWelcomeAnswer` and `KeyGroupPushJoin` already read the body; [chat](../frontend/modules/chat.md#a-2xx-a-captive-portal-answered-is-no-answer-2026-10-25))

**The reading that closes it:** on the Mi 9T behind a plain-HTTP portal: a notification reply stays in the outbox with one `HTTP 200 with a body that is not JSON` line and leaves once the portal ends; `postChannelRead` still trusts a 200/201 (a read mark, re-sent by the foreground)
