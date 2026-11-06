-- Migration 137 : an answer keeps the priced lines it was charged for (owner, 2026-11-06).
--
-- docs/wiki/frontend/modules/forms.md, "The priced grid". A `product_grid` question is an order -
-- rows x columns, a quantity per cell, a price per category - and `submit` computes its lines on the
-- server. `submissions."totalPaid"` keeps only their sum, which cannot be split back into lines, and
-- the grid itself may be edited after 40 orders (a row renamed, a price moved). The export and the
-- responses must say what was CHARGED, so the lines are copied onto the answer when it is written:
-- per ordered cell, the row and column ids and labels, the category, the unit price, the quantity.
--
-- 1. `submissions.lines`: jsonb NULL. Null on every existing row and on every answer to a form with
--    no product grid. No backfill: no answer before this file has a grid to copy.
--
-- ADDITIVE: one nullable column, no default, no constraint - a catalogue change, no rewrite of
-- `submissions`. Idempotent for CD: IF NOT EXISTS.
-- LOCKS: ACCESS EXCLUSIVE on `submissions` for the catalogue change alone (no scan), released at
-- COMMIT; the migration gives up after 5 s rather than queue behind a long transaction.

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS lines jsonb NULL;

COMMIT;
