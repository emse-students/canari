### Fixed - on the iPhone, the selected feed tab showed an empty yellow pill with no label

The sliding pill was drawn over its own label by iOS WebKit once the row overflowed; the labels now sit above it by an explicit stacking order and the pill no longer lives on a 3D layer ([design-reference](docs/wiki/frontend/design-reference.md#one-accent-four-tokens-and-a-guard-that-counts-the-amber-scale-owner-2026-11-09)).
