### Fixed - channel history and queued messages survive a PIN change and a PIN recovery

A recovery after a PIN changed on another device left every salon seed under the old key, so this device lost the channel history the server cannot re-send; both paths also stranded the unsent outbox. One path now re-seals every device-key-sealed store, resumably ([auth](docs/wiki/frontend/modules/auth.md#what-the-device-key-seals-and-what-a-pin-change-does-with-each)).
