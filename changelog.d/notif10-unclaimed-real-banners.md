### Fixed - a push refused after real banners no longer leaves a generic "Nouveau message de ..." line

The Android banner ledger now remembers, bounded and cleared with the notification, the real banners no push was waiting for, so a push refused for good (the engine already held the message) posts nothing next to them ([mobile](docs/wiki/frontend/mobile.md)). Owed one NOTIF-10 run on the Mi 9T.
