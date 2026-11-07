-- Migration 019: which first-time helps (guided tours, hints) an account has seen.
--
-- Asked for by the owner on 2026-11-02: a short guided visit at first launch, and first-time helps
-- after it, each shown ONCE PER ACCOUNT across devices - so the "seen" state is server-side, as
-- `platform_announcement_seen` (migration 006) is, and for the same reason: local state is wiped by
-- a reinstall, and a tour that replays on every new phone is noise.
--
-- One row answers one question, "has this account seen this help". `help_id` is one of the ids in
-- `libs/contracts/help-ids.json`, refused otherwise at the route, so an account holds at most one row
-- per declared help. `user_id` is `users.id` as spelt there (varchar(255), not always a UUID).
--
-- Erased with the account (`CORE_ERASURE_STATEMENTS`, label `help_seen`).
--
-- ADDITIVE ONLY: a new table, nothing existing touched. A release that predates it never reads it,
-- so a rollback is safe. Idempotent: the deploy ledger replays a file whose predecessor failed.

CREATE TABLE IF NOT EXISTS help_seen (
    user_id  VARCHAR(255) NOT NULL,
    help_id  VARCHAR(64)  NOT NULL,
    seen_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, help_id)
);
