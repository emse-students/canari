## Reading owed - a GIF never reaches `static.klipy.com` from a reader's browser: the relay carries every recipient's GIF, the picker's...

target: 1.7.0

**What is built:** a GIF never reaches `static.klipy.com` from a reader's browser: the relay carries every recipient's GIF, the picker's thumbnails and a comment GIF (#2016, `v1.3.0`; [chat](../frontend/modules/chat.md#the-gif-relay-no-readers-browser-asks-klipy-for-a-gif-2026-10-18))

**The reading that closes it:** a network trace on dev across a GIF bubble, a quoted GIF, the picker and a comment attach: zero request to `static.klipy.com`; the same look on the Mi 9T and the iPhone 12; then a day of `[GIF_MEDIA]` lines (refusals by reason, cache hits)

**Read 2026-11-14 on dev (`1.6.12-alpha.2`, two desktop Chrome profiles, test accounts):** the picker (thumbnails) and a received GIF bubble drew with ZERO request to `static.klipy.com` (every request went to the estate's own host). Still owed: a quoted GIF, a comment attach, the two phones, then the day of `[GIF_MEDIA]` lines.

**Web half closed 2026-11-14 on dev:** a GIF sent from the picker, the same GIF QUOTED in a reply (composer preview and the reply bubble) and a GIF attached to a post COMMENT all drew with ZERO request to `static.klipy.com`; every image came from the estate's host or a local blob. **The `[GIF_MEDIA]` lines, production, 09:11-12:40 UTC (read-only):** 116 lines, 0 refusals, 87 relays cached, 25 cache hits, 4 relays over the 4 MB entry ceiling (not cached, as designed). **Mi 9T half read the same day (Android WebView, dev, Alpha): the picker thumbnails and a sent GIF bubble drew, ZERO request to `static.klipy.com` (the WebView request log carried only the estate's host); the GIF sent for the reading was deleted. Left: the iPhone 12 (the same look) - the iPhone agent.**

**iPhone 12 half read 2026-11-14 on dev (TestFlight `1.6.12-alpha.2`, gamma, a DM with delta):** the picker's thumbnails drew, a GIF sent from it drew in the sender's bubble, and a USB packet capture of the whole phone (`python -m pymobiledevice3 pcap`, about 11 MB across opening the picker, sending and deleting the GIF) holds ZERO occurrence of `klipy` (no DNS name, no TLS server name) and 46 of `dev.canari-emse.fr`. Caveat, stated once: two `cloudflare-ech.com` server names appear in the capture, and an ECH-wrapped name would not show as `klipy`; the thumbnails and the bubble came from the estate (the picker's "Powered by KLIPY" is a label). The GIF was deleted. **Left: the same look on the Mi 9T.**
