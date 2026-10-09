### Fixed - the conversation rises with the keyboard when you are at its bottom

The pinned-to-bottom judgement watched `scrollHeight`, which does not move when only the pane's box shrinks, so the keyboard covered the last messages and the scroll-to-bottom arrow appeared. It now watches the reach (`scrollHeight - clientHeight`), measured in headless Chrome at 390x844: distance from the bottom 330 px before, 0 after ([chat](docs/wiki/frontend/modules/chat.md#a-box-shrinking-is-growth-too-the-keyboard-and-the-pinned-thread-2026-10-09)).
