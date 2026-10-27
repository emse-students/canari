### Fixed - a group opened from a DM no longer shows an empty transcript until a reload

The DM header's presence teardown read a prop and made the open conversation's pane stop listening to it. Teardowns now release a captured value ([architecture](docs/wiki/frontend/architecture.md#a-teardown-that-reads-a-prop-can-rewire-a-parents-derived-and-nothing-throws-2026-10-27)).
