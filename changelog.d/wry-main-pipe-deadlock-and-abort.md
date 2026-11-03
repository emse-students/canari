### Fixed - Android: a frozen app when its window closed, and a crash on a message for a closed window

Two Play reports traced to wry's Android main pipe: the main thread could block forever sending into a full channel only it drains (ANR), and a message reaching an already-destroyed window aborted the process. wry is now a vendored fork with both fixed ([mobile](docs/wiki/frontend/mobile.md#wry-main-pipe-patch)).

### Added - a PLATFORM verdict in the Play vitals watch

A crash with no Canari frame (the first: an AAudio use-after-free inside Android) is recorded as PLATFORM with its evidence, and re-opens as NEW the moment that evidence breaks ([play-vitals](tools/play-vitals/README.md#platform-issues)).
