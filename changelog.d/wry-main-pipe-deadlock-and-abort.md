### Fixed - Android: a frozen app when its window closed, and a crash on a message for a closed window

Two Play reports traced to wry's Android main pipe: the main thread could block forever sending into a full channel only it drains (ANR), and a message reaching an already-destroyed window aborted the process. wry is now a vendored fork with both fixed ([mobile](docs/wiki/frontend/mobile.md#wry-main-pipe-patch)).
