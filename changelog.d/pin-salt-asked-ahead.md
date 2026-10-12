### Changed - a PIN unlock no longer waits for the salt after the PIN is typed, nor for the device key behind the check

The salt is asked while the keypad is up, and the device key is derived next to the verifier but installed only after the PIN check passed - ~0.5 s of a cold notification open on the Mi 9T ([latency](docs/wiki/frontend/notification-to-conversation-latency.md#f9---the-pin-salt-is-asked-while-the-keypad-is-up-and-the-two-derivations-run-together-built-phone-beforeafter-pending)).
