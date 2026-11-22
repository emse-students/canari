### Fixed - a GIF from the Android keyboard reaches the conversation again

Gboard said "GIF non disponibles ici" because the WebView's input-connection hook, written into a generated file, was erased by a regeneration in July; it now lives in the vendored wry template and a gate test fails if it goes again ([chat](docs/wiki/frontend/modules/chat.md#android-keyboard-media-commitcontent)).
