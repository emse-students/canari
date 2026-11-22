### Fixed - the feed tab row cancels the column's top padding with the token, so no band can come back under the header

The 2026-11-22 report from an iPhone without Liquid Glass (a black band under the header, the first tab clipped) came from a `1.6.0`-`1.6.8` build, where both defects existed on every phone; the offset that removed the band is now written with `--page-column-top` instead of a raw number, and the no-glass fallback is asserted to change paint only ([design-reference](docs/wiki/frontend/design-reference.md)).
