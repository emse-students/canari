### Fixed - an Add no longer answers `400` once per stale device it admits

The inviter's join push was refused `addressed_unsupported` for every offline or older device of an Add (nine in one dev run); the Welcome's answer now says whether the server can address the device, and the push is not sent where it would be refused ([history-answer-addressing](docs/wiki/protocols/history-answer-addressing.md#the-rules-as-built)).
