### Fixed - Android's Back no longer leaves the app while a dialog opened by a Back is up

After a first Back on a filmed take, the "Abandonner cette capture ?" question could not be closed by a second Back: Chromium refused to step back from its history entry and the app finished. The activity now asks the page first, and the Back closes the question ([device-verification](docs/wiki/device-verification.md#the-camera-tab-and-android-back---read-on-the-mi-9t-163-alpha2-2026-11-02)).
