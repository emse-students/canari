### Fixed - drag zones, tab-row observers and the focus moves no longer depend on Svelte's action order

Svelte 5.59 runs actions and effects before the sibling blocks render, which would have disarmed the rail's drag zones, the tab and chip observers and the focus of the ring and of an opened form card; each now follows the DOM or its own element ([architecture](docs/wiki/frontend/architecture.md#svelte-559-runs-actions-and-effects-before-the-sibling-blocks-render-2026-11-24)).
