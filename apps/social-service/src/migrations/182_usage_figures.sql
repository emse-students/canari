-- Migration 182: the usage dashboard's durable figures (owner, 2026-11-16 and 2026-11-19;
-- docs/wiki/usage-dashboard.md, docs/wiki/compliance/register-of-processing.md row C31).
--
-- One row per (period, first Paris day, metric, dimension): how many distinct people used Canari, or
-- how many messages, posts, CanaReels, lives, calls or form answers were made, in a day, an ISO week
-- or a calendar month - overall (`all`), per platform category (`cat:...`) or per app version
-- (`ver:...`). NO PERSON IN IT: no account, no device, no content. Written only by the fold
-- (`usage/usage-fold.ts`), which keeps the larger value; kept with no limit (owner).
--
-- ADDITIVE: one new table, nothing else read or written. ROLLBACK: an image older than this one never
-- reads the table; `DROP TABLE usage_figures` by hand loses only the dashboard's history.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS usage_figures (
  period varchar(8) NOT NULL,
  start date NOT NULL,
  metric varchar(16) NOT NULL,
  dimension varchar(48) NOT NULL,
  value bigint NOT NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_figures_pkey PRIMARY KEY (period, start, metric, dimension),
  CONSTRAINT usage_figures_period CHECK (period IN ('day', 'week', 'month')),
  CONSTRAINT usage_figures_value CHECK (value >= 0)
);
