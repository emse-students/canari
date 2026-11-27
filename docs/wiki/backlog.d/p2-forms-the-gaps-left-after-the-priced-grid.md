## P2 - forms: the gaps associations hit that the priced grid did not close (audit of 2026-11-06, section 5 from G-DUP down)

target: 1.9.1

The audit's defects and its decided priced grid (`product_grid`, WP-G0..G5) shipped from `1.6.6` on.
What it ranked AFTER them is not built, in the recommended order: **G-DUP** duplicate a whole form
(the editor already duplicates a question), **G-EXPORT** accounting
columns, **G-QUOTA** per option (shares the seat lock), **G-RESULTS** a managers-only summary (BUILT, owner 2026-11-21, target 1.8.0: [reading](p2-forms-results-summary-read-on-dev.md)), then
**G-WAITLIST** and **G-SEATS** designed together (both change what a seat is), then the rest. G-EDIT
is closed (won't do) and G-STOCK is "not now" (owner, 2026-11-06); the owner's answers Q1-Q8 are in
section 8. G-VALID (answer formats) moved to [its own entry](../frontend/modules/forms.md#answer-formats-on-a-short-text-question-and-the-empty-answer-stored-as-absent-owner-2026-11-21-180), owner 2026-11-21.

Impact, effort, files, migration and risk of each, and the benchmark behind them:
[forms capability audit, section 5](../forms-capability-audit-2026-11-06.md#5-the-other-gaps-ranked).
