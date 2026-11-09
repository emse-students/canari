### Changed - small labels, badges and table headers are sentence case, without letter-spacing

The audit's item M3: 76 components stop forcing capitals and wide tracking, and a guard test (`uppercaseTracking.test.ts`) keeps them out; two abbreviation cases are allowlisted ([design-reference](docs/wiki/frontend/design-reference.md#small-labels-are-sentence-case-with-no-letter-spacing-2026-11-09-audit-item-m3)).

The guard now also reads CSS (`text-transform: uppercase`, a letter-spacing of 0.05em or more, in every `.css` and `<style>`), which found the floating day pill in `app.css`; it is sentence case like the inline separator. The attachment file-type badge keeps its capitals as an allowlisted abbreviation.
