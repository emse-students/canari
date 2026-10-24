### Fixed - an accepted background Welcome reaches the device even when the app opens during the round trip

The Android background Welcome now stages its Add in `mls.bin` with its submission record, and the foreground settles any stage the background could not, so nothing waits on the network ([chat-delivery](docs/wiki/services/chat-delivery.md#the-background-welcome-answers-what-happened-and-the-stage-is-merged-only-on-an-acceptance-2026-10-22)).
