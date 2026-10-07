### Fixed - a CanaReels photo took 4 s to reach its review on Android

`canvas.toBlob` waits a flat ~4 s on the Android WebView; the photo (and the editor export, image upload compression and square cropper) now encode through `toDataURL`, 69 ms measured on the Mi 9T. See [reels](docs/wiki/frontend/modules/reels.md).
