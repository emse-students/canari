### Added - the cross-client rig can click and type on the iPhone, and drive its system screens

Under `CANARI_PHONE=ios` the I1 connection performs every CDP `Input.*` frame as a WebDriverAgent touch or key (`webkit-input.mjs`), and `phone-ios.mjs` gains airplane mode, the link conditioner, force-quit, Settings, reboot, a fresh install with its sign-in sheet, deep links and notification actions - fixtures only, nothing run on the device yet ([cross-client-ios](docs/wiki/cross-client-ios.md)).
