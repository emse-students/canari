### Changed - the keyboard and a sent message move like Messenger's

On Android the keyboard slides opaque instead of fading, and the page lays itself out for it before
the WebView is resized, so no frame shows the composer cut off; a send glides the thread, then fades
the bubble in, which no longer changes size at delivery; the composer bar takes Messenger's
dimensions ([keyboard-and-send-motion](docs/wiki/frontend/keyboard-and-send-motion.md)).
