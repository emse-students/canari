### Fixed - a group notice received late no longer sinks below the conversation that followed it

A device that drained "X added A, B" hours after the event dated it with its own clock, so a phone opening a group for the first time drew it at the bottom; every notice a received frame draws is now dated by the frame's `sentAt` and the server's acceptance ([chat](docs/wiki/frontend/modules/chat.md#a-visible-notice-is-dated-by-its-frame-never-by-when-this-device-learnt-of-it)).
