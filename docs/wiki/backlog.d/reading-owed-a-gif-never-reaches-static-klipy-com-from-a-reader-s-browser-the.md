## Reading owed - a GIF never reaches `static.klipy.com` from a reader's browser: the relay carries every recipient's GIF, the picker's...

target: 1.7.0

**What is built:** a GIF never reaches `static.klipy.com` from a reader's browser: the relay carries every recipient's GIF, the picker's thumbnails and a comment GIF (#2016, `v1.3.0`; [chat](../frontend/modules/chat.md#the-gif-relay-no-readers-browser-asks-klipy-for-a-gif-2026-10-18))

**The reading that closes it:** a network trace on dev across a GIF bubble, a quoted GIF, the picker and a comment attach: zero request to `static.klipy.com`; the same look on the Mi 9T and the iPhone 12; then a day of `[GIF_MEDIA]` lines (refusals by reason, cache hits)

**Read 2026-11-14 on dev (`1.6.12-alpha.2`, two desktop Chrome profiles, test accounts):** the picker (thumbnails) and a received GIF bubble drew with ZERO request to `static.klipy.com` (every request went to the estate's own host). Still owed: a quoted GIF, a comment attach, the two phones, then the day of `[GIF_MEDIA]` lines.
