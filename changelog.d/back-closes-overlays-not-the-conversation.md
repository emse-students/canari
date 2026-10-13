### Fixed - the system Back closes the message sheet, not the conversation under it

The long-press sheet and ten other screen-level surfaces (seven dialogs through `ModalOverlay`, every picker sheet) now hold a history entry, a closed sheet's leftover entry no longer costs a Back, and a test fails any surface that registers none ([mobile](docs/wiki/frontend/mobile.md#one-back-with-the-message-sheet-open-closed-the-sheet-and-the-conversation-and-ten-more-surfaces-shared-the-cause-2026-10-13)).
