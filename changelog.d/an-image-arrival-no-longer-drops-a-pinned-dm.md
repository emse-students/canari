### Fixed - an image arriving at a pinned DM no longer drops the pane on the iPhone

The new-message effect pinned the end a second time inside the arrival's glide, read the glide's
overflow and wrote past the end; the engine's clamp then read as a fall. The pane now pins only
against the layout (`pinThreadToEnd`), and a reader at the end has one writer
([chat](docs/wiki/frontend/modules/chat.md#the-cause-a-second-writer-pinned-inside-the-glide-2026-11-25)).
