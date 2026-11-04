## P3 - the iOS native tab bar's show and hide can apply out of order (found in review, 2026-11-04)

`showTabBar` / `hideTabBar` (the patched `tauri-plugin-system-components`) are ASYNC Rust commands:
each runs on its own runtime worker and hops to the main queue, so a hide quickly followed by a show
(the keyboard closing as a conversation opens, `NativeTabBar.svelte`'s visibility effect) may reach
UIKit in the reverse order and leave the bar hidden where the layout wanted it shown, or the reverse.
Not observed on a phone; read off the shape in the review of the tour fix, which met the same race
on `set_tab_bar_interactive` and fixed it with a rising `seq` Swift checks ([guided-help](../frontend/guided-help.md)).

Not fixed in the same change because the two commands come from the PUBLISHED JS API
(`@sosweetham/tauri-plugin-system-components-api`), which sends no argument: the fix is the same
`seq`, carried by invoking them by name from `systemComponentsCommands.ts` instead of the package,
with the Swift `setHidden` dropping an older sequence and `configureTabBar` resetting it. A plain
(non-async) Rust command is NOT the fix: a sync command runs on the main thread and blocks it waiting
for Swift, which answers from `DispatchQueue.main.async` - a deadlock. Pinned the same way as the
interaction switch: `systemComponentsPatch.test.ts`.
