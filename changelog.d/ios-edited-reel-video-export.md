### Fixed - an edited video take can leave the CanaReels editor on the iPhone

A video with text, a sticker or a drawing failed on "Suivant" on iOS, whose WebView has no `video.captureStream`. The overlays are now painted frame by frame with WebCodecs, the engine publishing already needs, and the real-time recorder path is gone. See [reel-editor](../docs/wiki/frontend/modules/reel-editor.md).
