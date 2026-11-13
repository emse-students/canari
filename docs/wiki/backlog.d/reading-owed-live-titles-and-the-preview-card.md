## Reading owed - live titles and the preview card

target: 1.7.0

**What is built:** live titles and the preview card (#3135, first stable `v1.6.7`; [lives](../services/lives.md#titles-and-the-preview-image-owner-2026-11-07))

**The reading that closes it:** on dev, on the Mi 9T and the iPhone 12: the canvas grab on both engines (camera, and a shared screen on a desktop) and the JPEG size of a 480 px frame (bound 256 KiB); the card's refresh on screen and its stop off screen and in the background (`[LIVE] feed card: reading the list (on screen)`); the carousel with two lives on air; the push text with and without a title on Android and iOS; the HKDF poster key opening on both engines, and one `GET /api/media/public/live-poster/...` per new name, none repeated
