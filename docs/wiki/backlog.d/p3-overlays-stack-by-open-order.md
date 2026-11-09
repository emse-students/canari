## P3 - overlays stack by open order: one registered overlay stack that assigns z by open time, instead of fixed rungs

Not built. Every overlay sits on a fixed rung of `app.css`'s ladder, and "what a dialog opens must
clear it" is enforced by a context (`utils/viewerLayer.ts`: `Modal` and the page-level
`CommentsDrawer` mark their subtree, a nested dialog takes `--z-viewer-dialog`, its dropdowns
`--z-viewer-dialog-popover`). Each new nesting (a popover in a nested dialog, a picker in a sheet)
has needed another rung and another reader of the context.

Owed: ONE registered overlay stack - an overlay registers when it opens and is given its z by open
time (the last opened is on top), released on close - so no component names a rung and no nesting
needs a new one. The ladder keeps only the non-overlay layers (navigation, banner, toast, tooltip).
`ModalOverlay`, `Modal`, `CommentsDrawer`, `FloatingSurface` and `UserAutocomplete` are the consumers
to move; `historyOverlayStack` already tracks open order for the Back gesture and is the natural
starting point. Mechanism today: [viewerLayer](../../../frontend/src/lib/utils/viewerLayer.ts).
