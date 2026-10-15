### Fixed - a PIN change on an iPhone with no passcode stopped after the server had taken it

The keychain refused the biometric item on a phone without a passcode, untyped, so the change told the user to retry a PIN the server had already rotated and the recovery failed the same way. The item is no longer written where it cannot exist, both old items go first, and a keystore refusal is a typed, no-data-moved stage ([auth](docs/wiki/frontend/modules/auth.md#a-keychain-that-cannot-hold-the-biometric-item-ios-with-no-passcode-2026-10-15)).
