### Fixed - an upload from the phone app no longer inflates its body ~85 times in memory

On Android and iOS the HTTP plugin turned every request body byte into a JSON number, so a 13 MB upload cost +1.2 GiB in the app and 50 MB crashed it. A file, blob or form body sent to Canari's own API now goes through the WebView's own `fetch`, which streams it. See [media streaming upload](docs/wiki/services/media-streaming-upload.md) and [mobile](docs/wiki/frontend/mobile.md#a-binary-body-through-the-http-plugin-costs-85-times-its-size-and-50-mb-crashes-the-app).
