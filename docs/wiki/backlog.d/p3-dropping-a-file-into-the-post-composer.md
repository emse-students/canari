## P3 - dropping a file into the post composer does nothing (owner, 2026-11-08, "pour plus tard")

Reported on the web composer of a post (desktop browser): an image dragged over the text shows the
browser's move cursor ("le déplacement") and dropping it attaches nothing. Not yet reproduced.

What the code already does, so the hunt does not start from zero: `CreatePostForm.svelte` passes
`onmedia={addFiles}` to `MarkdownComposerField`, and `MentionComposerInput.svelte`
(`handleEditorDrop`) hands `filesFromTransfer(...)` (`frontend/src/lib/utils/composerTransfer.ts`)
to it, refuses a local path the file manager withheld with a toast, and inserts plain text
otherwise. So a drop that lands ON the editor with real files should attach them. Candidates to
measure first, each with a log line already in place or to add: the drop lands outside the editor
(the sheet's padding, the media strip, the toolbar) where nothing listens - the chat composer
listens on its whole panel (`ChatComposer.svelte`, `chat-composer-panel`); the drag comes from
another web page, which hands an `<img>` as `text/uri-list`/`text/html` and no file, so nothing is
attached (decide: fetch the URL, or say why not); `dragover` not prevented on the element under the
pointer, so the browser never fires `drop`. Fix it as one drop zone for the whole post sheet,
shared with the chat composer's, with a visible drop state, and a test per transfer shape
([chat](../frontend/modules/chat.md) holds the composer transfer rules).
