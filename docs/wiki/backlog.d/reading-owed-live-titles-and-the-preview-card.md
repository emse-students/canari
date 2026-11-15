## Reading owed - live titles and the preview card

target: 1.7.0

**What is built:** live titles and the preview card (#3135, first stable `v1.6.7`; [lives](../services/lives.md#titles-and-the-preview-image-owner-2026-11-07))

**The reading that closes it:** on dev, on the Mi 9T and the iPhone 12: the canvas grab on both engines (camera, and a shared screen on a desktop) and the JPEG size of a 480 px frame (bound 256 KiB); the card's refresh on screen and its stop off screen and in the background (`[LIVE] feed card: reading the list (on screen)`); the carousel with two lives on air; the push text with and without a title on Android and iOS; the HKDF poster key opening on both engines, and one `GET /api/media/public/live-poster/...` per new name, none repeated

**Triage 2026-11-14 - left: Mi 9T about 25 min, iPhone about 25 min, a dev web seat about 10 min** (the phones go live with their own cameras; the carousel needs two lives on air: one phone and a web seat with a fake camera). The shared desktop SCREEN grab is DELETED: the screen picker cannot be driven on the bench; the canvas grab is read on the cameras.

**iPhone 12 half, partly READ 2026-11-15** (TestFlight `1.6.12-alpha.2`, dev; the broadcaster is the rig seat W5 with a fake camera, 640x480):
- **The card and its title.** The feed's "En direct" card on the phone showed the live's title, the association, the badge and a PICTURE ("Apercu d'il y a N s"); the picture changed between two readings (a 14 s then a 9 s age, two different frames), so the card refreshes on screen. The poster is served and decrypted on WebKit (the HKDF poster key opens: the card draws it). READ.
- **The push text with a title on iOS.** The banner read "Club d'Echecs Fictif est en live / Tournoi blitz 1115b" (title in the body), captured over the home screen. READ. The text WITHOUT a title is not read on iOS.
- **Server side of the poster.** `[LIVE_POSTER] ... stored (2827-4143 B)` for every grab of W5's 640x480 frame, far under the 256 KiB bound (that is the web engine's canvas, not the iPhone's).
- **Deleted, measured:** the card's stop "off screen and in the background" and the one-GET-per-name count cannot be read here: the TestFlight build's WebView is not inspectable (`pymobiledevice3 webinspector cdp` lists no page: `[]`), so the `[LIVE] feed card: reading the list (on screen)` console lines never reach a reader, and the object store's request log is not reachable from the bench.
- **Left:** the iPhone as BROADCASTER (the WebKit canvas grab and its JPEG size, from its own camera); the carousel with two lives on air (this sitting had ONE broadcaster, W5, and a second live needs a second account's seat); the title-less push text on iOS; the whole Mi 9T half.
