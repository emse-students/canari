## P3 - a sent file's bubble that failed to load during an outage stays failed after the link returns

target: 1.7.1

**Seen 2026-11-18 (iPhone 12, `1.7.0-alpha.11`, dev, [readings](../device-verification.md#the-phone-readings-of-2026-11-18-m1-and-i1-170-alpha11)):** a 45 MB file was uploaded and sent (`[OUTBOX] ... sent`), then the Wi-Fi was cut through Control Center. The bubble's media load failed (`E [MessageBubble] media not shown (other) <media> TypeError: Load failed`) and the bubble drew the file name with a red retry icon. The Wi-Fi came back and, more than a minute later, the bubble still showed the retry icon: nothing reloaded it on reconnection.

**What is not known:** whether a tap on the icon recovers it (not tried), and whether this differs from `v1.6.12` (not shown to be a regression). The log line is an error for a transport failure, which the noise rule asks to explain.

**The reading that closes it:** the same cut on the iPhone and the Mi 9T after a send; once the link is back the bubble draws the file without a hand on it, and the failure is logged at the level a transport failure deserves.
