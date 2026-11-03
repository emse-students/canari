### Fixed - the GIF picker of a comment box opens above the comments sheet, not under it

The picker sat on `--z-sheet` while a post's comments sheet (`CommentsDrawer` on a phone, `Modal` on a larger screen) sits on `--z-modal`, so it opened dimmed behind the sheet. A page-level drawer and a `Modal` now mark their subtree like a viewer, and what they open takes `--z-viewer-dialog` ([viewerLayer](frontend/src/lib/utils/viewerLayer.ts)).
