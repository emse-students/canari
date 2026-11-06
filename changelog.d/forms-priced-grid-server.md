### Added - forms: the priced grid (`product_grid`), server side

A new question type for orders (sizes x colours, a quantity per cell, a price per row, per column or for all, per category with guests paying "autres"). The server judges the grid at save, recomputes every amount at submit and hands Lydia that one total. Each answer keeps the lines it was charged for (migration 137), and the export gains "Articles" and "Totaux" sheets. Mechanism: [forms](docs/wiki/frontend/modules/forms.md#the-priced-grid-product_grid-wp-g1-2026-11-06).
