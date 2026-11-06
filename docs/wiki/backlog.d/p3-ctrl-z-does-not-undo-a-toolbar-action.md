## P3 - Ctrl+Z does not undo a markdown toolbar action in the composer

Found in the review of #3057 (2026-11-06), and older than it. The toolbar rewrites the value through
`setText` and restores the selection, but the editor is a contenteditable rebuilt from the text, so
the browser's undo stack never sees the change: Ctrl+Z after Gras skips the formatting or reverts
something earlier. A fix keeps its own undo stack of `(text, selection)` snapshots for toolbar
actions, or applies the edit through `document.execCommand('insertText')` on the selection. Mechanism
and the rest of the toolbar contract: [markdown-coherence](../frontend/markdown-coherence.md).
