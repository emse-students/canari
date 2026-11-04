### Fixed - a closed iOS sign-in sheet no longer leaves the login button busy until the app is killed

The in-app browser plugin now answers how its sheet ended (`completed`, `cancelled`, `handedOff`), and the login page hands the button back on `cancelled` ([mobile](docs/wiki/frontend/mobile.md#oidc-login-opens-a-dedicated-in-app-browser-session-wp-oidc-tab-1-android-shipped-and-verified-2026-08-08-ios-verified-on-hardware-2026-08-27)).
