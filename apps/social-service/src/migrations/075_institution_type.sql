-- Migration 075: `associations.type` gains 'institution' (WP6e of the profile reform,
-- docs/wiki/profiles-and-access.md, D20 and the "Personnel" row of the decisions).
--
-- An institution (the School, a ME, the Alumni association) is an association row of its own type:
-- created by a global admin only (the controller refuses anyone else), its members added by name,
-- publishing and proposing events through the same POST_AS_ASSO / PROPOSE_EVENT flags as an
-- association, and republishing like one (REPUBLISHING_ASSOCIATION_TYPES). Its audience rules are
-- its ceiling, in the same `association_audiences` table.
--
-- Until now the column was a free varchar guarded only by the DTO. The CHECK makes the three kinds
-- a fact of the table: a fourth would have to be added HERE, with its readers, not by accident.
-- Every existing row is 'association' or 'list' (nothing else could be created), so it validates.
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.
ALTER TABLE associations DROP CONSTRAINT IF EXISTS "CHK_associations_type";
ALTER TABLE associations
    ADD CONSTRAINT "CHK_associations_type" CHECK (type IN ('association', 'list', 'institution'));
