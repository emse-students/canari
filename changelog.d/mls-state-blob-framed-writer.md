### Fixed - a damaged local MLS state no longer asks for an old PIN, and another account's state on a phone is no longer offered for reset

Every save now carries the key fingerprint header, so a state altered under the right key rotates the device identity with no PIN asked, a PIN changed elsewhere is named as such, and a phone records whose `mls.bin` it holds so another account's gate withholds the reset ([mls-protocol](docs/wiki/protocols/mls-protocol.md#the-state-blobs-framing---read-first-write-later)).
