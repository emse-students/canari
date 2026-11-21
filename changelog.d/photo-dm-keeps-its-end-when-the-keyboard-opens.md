### Fixed - a DM ending in photos no longer lands on older messages when the keyboard opens

A thread that shrank in one frame and grew back in the next (photos under a changing height ceiling)
made the scroll measurement read the thread's own move as the reader going up: the stick-to-bottom
flag fell and the reader stayed screens above the newest rows. The pane's own placements are now the
baseline of that measurement
([chat](docs/wiki/frontend/modules/chat.md#the-flag-is-only-ever-the-readers-2026-11-21)).
