### Fixed - a tap on a salon no longer also activates the message it puts under the finger

For whoever may reorder the salons, `svelte-dnd-action` added its own click to the browser's on every tap, and that first click disarmed the click guard; the library is patched and the guard judges pointer clicks only ([design-reference](docs/wiki/frontend/design-reference.md#the-mechanism-two-clicks-per-tap-on-the-salon-list-and-the-first-one-disarmed-the-guard-2026-10-13)).
