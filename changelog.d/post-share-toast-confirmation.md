### Fixed - sharing a post's link now confirms with a toast, not a checkmark the menu hides

The "Lien copié" confirmation flashed inside the actions menu for the ~150ms it took the menu to
close and vanish, not the 2 seconds it intended; a toast survives the menu closing
([posts](docs/wiki/frontend/modules/posts.md#share-confirmed-inside-a-menu-that-had-already-closed-2026-09-27)).
