### Fixed - Lydia's `signature` is no longer logged, and an unbounded free amount reads "Libre"

core-service redacts `signature` in the Lydia call log like the two token fields; the shop card no longer prints "Libre (0-inf EUR)" for a product with no bounds. See [cotisations](docs/wiki/cotisations.md).
