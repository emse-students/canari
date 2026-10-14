### Fixed - on iPhone, a link that launches the app opens its page again

Since `v1.2.0` (tauri 2.12), "Ouvrir dans l'application", a Universal Link or a deep link that had to start the app opened it on the feed: tao's scene delegate drops the launch URL. The app now hands it on itself; native, so it ships with the next store build ([mobile](docs/wiki/frontend/mobile.md#a-cold-start-on-the-scene-lifecycle-lost-its-link)).
