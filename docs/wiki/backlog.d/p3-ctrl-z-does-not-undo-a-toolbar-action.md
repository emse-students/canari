## P3 - Ctrl+Z does not undo a markdown toolbar action in the composer

Found in the review of #3057 (2026-11-06), and older than it. The toolbar rewrites the value through
`setText` and restores the selection, but the editor is a contenteditable rebuilt from the text, so
the browser's undo stack never sees the change: Ctrl+Z after Gras skips the formatting or reverts
something earlier. A fix keeps its own undo stack of `(text, selection)` snapshots for toolbar
actions, or applies the edit through `document.execCommand('insertText')` on the selection. Mechanism
and the rest of the toolbar contract: [markdown-coherence](../frontend/markdown-coherence.md).

**Brief (batch 23, 2026-11-12) - one frontend agent, a small PR born `--draft`.** Take the
first option, the app's own stack: `execCommand` is deprecated and a contenteditable rebuilt from
the text would lose what it records. The toolbar pushes a `(text, selection)` snapshot before
each action; Ctrl+Z / Cmd+Z (and Ctrl+Shift+Z / Ctrl+Y to redo) pop it while the last change was
a toolbar action, and hand over to the browser otherwise; typing clears the redo side. Tests: the
composer's component test - Gras then Ctrl+Z restores the text and the selection, a typed word
after a toolbar action is undone by the browser, not by the stack.
