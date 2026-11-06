### Fixed - selecting text in a field inside a reorderable card no longer drags the card

In the form editor (question cards) and the association members list, pressing and dragging inside a text field dragged the whole card instead of selecting. A press on a field, button, link or editable area now never starts a drag; the grip and the inert parts of the card still do. One rule in [architecture](docs/wiki/frontend/architecture.md#a-draggable-card-never-starts-a-drag-from-a-field-2026-11-06).
