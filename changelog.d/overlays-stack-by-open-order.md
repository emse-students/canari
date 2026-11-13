### Changed - overlays stack by open order, not by fixed rung

Every dialog, sheet, popover, drawer and viewer registers on one overlay stack when it opens and
takes its z-index from the open order (the last opened is on top), so a dialog opened from a viewer
or a picker opened from a sheet is always in front and no nesting needs a new rung
([design-reference](docs/wiki/frontend/design-reference.md#the-overlay-stack---what-is-on-top-is-what-opened-last-2026-11-13)).
`utils/viewerLayer.ts` and the overlay rungs of the layer ladder are removed.
