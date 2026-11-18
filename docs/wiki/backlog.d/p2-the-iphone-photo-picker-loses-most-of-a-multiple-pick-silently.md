## P2 - READ ON THE NEXT 1.7.1 PRE-RELEASE: the iPhone's photo picker kept every item of a multiple pick

target: 1.7.1

**Fixed in code, owed one phone reading.** The 11-item pick of `1.7.0-alpha.12` gave 3 attachments and logged `No such file or directory` once per lost item. Cause, found in `tauri-plugin-dialog` 2.8.3's `FilePickerController.swift`: every PHPicker item was copied to `<caches>/<source file name>` after DELETING whatever held that name, and the results were appended from several threads at once - two items sharing a name overwrote each other and the list named one path twice, so the page read it once and found nothing the second time. The crate is now vendored (`src-tauri/patches/tauri-plugin-dialog`): one `canari-pick-<uuid>/` directory per item (removed once the copy is read, `picked_files.rs`), a serial queue for the shared state, the pick's order kept. A read that still fails is counted in a warning toast (`composer_native_pick_unread`) instead of leaving only the count. Mechanism: [chat](../frontend/modules/chat.md) (the iOS native picks).

**The reading that closes it:** the same pick of 11 (limited library access, short videos) on the iPhone 12 gives 11 attachments in the composer, or 10 and a notice if the cap bites; `ios.yml`'s dispatch must have compiled the Swift first.
