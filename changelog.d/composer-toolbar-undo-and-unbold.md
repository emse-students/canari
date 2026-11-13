### Fixed - Ctrl+Z undoes a toolbar action, and Gras can come off the last word of a bold ending in an italic

In the composer, Ctrl/Cmd+Z (and redo) now undo and redo a formatting button from the field's own
history, leaving typing to the browser; and `Le **prix *reduit***` takes Gras off "reduit" instead of
refusing ([markdown-coherence](docs/wiki/frontend/markdown-coherence.md)).
