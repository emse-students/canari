### Fixed - messages and Graine seeds received after an in-session PIN change are sealed under the new key

The message pipeline and the Graine runtime captured the device key at login and kept sealing under it after a PIN change, leaving data unreadable at the next launch; they now read the key at each write ([durable-rules](docs/wiki/durable-rules.md#mls-state-and-keys---mls-protocol-auth)).
