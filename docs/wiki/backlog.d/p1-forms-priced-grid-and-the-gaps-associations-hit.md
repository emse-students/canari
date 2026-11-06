## P1 - forms: a grid question cannot be submitted, and associations cannot sell variants (owner, 2026-11-06: the absolute priority, ships in `1.6.6`)

**A defect first**: every form holding a visible survey grid (`matrix_single`, `matrix_multiple`) is
refused at submit since 2026-06-01, because `IsValidAnswers` refuses the grid's object answer (D1,
probed on the DTO; one submit on dev still owed). **Then the decided feature**: a new question type
`product_grid` - rows x columns, a quantity stepper per cell with a creator-set maximum, prices for
the whole grid, per row or per column, set per category (a guest pays "autres"), closed cells, no
stock, one new order instead of an edit, opened as soon as it ships - in six work packages
WP-G0..WP-G5 (WP-G0, the D1 fix, first and alone). Every product question is decided; the other gaps
are ranked with impact, effort and risk.

Design, decisions, defects and the ranked gaps: [forms capability audit](../forms-capability-audit-2026-11-06.md).
