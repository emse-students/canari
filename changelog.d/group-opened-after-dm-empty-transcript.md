### Fixed - a group opened from a DM no longer shows an empty transcript until a reload

A derived read in the DM header's teardown stopped the open conversation's pane from listening to it, and a stale read in another teardown kept a read mark from being delivered on leave. Teardowns now read only captured locals ([architecture](docs/wiki/frontend/architecture.md#a-teardown-sees-the-values-its-effect-saw-and-a-derived-read-there-keeps-them-2026-10-27)).
