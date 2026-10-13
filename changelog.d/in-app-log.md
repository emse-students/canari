### Added - an in-app diagnostic log a member can save from Settings > About

Store builds logged no JavaScript anywhere; the app now keeps its own redacted log lines in a 2 MiB ring on the device, saved only when the member asks. The dead `attachConsole()` call is removed ([mobile](docs/wiki/frontend/mobile.md#the-in-app-log)).
