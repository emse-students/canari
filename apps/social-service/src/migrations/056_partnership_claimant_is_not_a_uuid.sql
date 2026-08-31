-- Migration 056: a partnership code's claimant was typed `uuid`, and a user id is not one.
--
-- Migration 047 declared `partnership_codes."claimedByUserId" uuid`. Every OTHER user-id column in
-- this service - `association_members`, `channel_members`, `form_submissions`,
-- `document_reviewer_grants`, `association_role_history` - is `varchar(255)`, because a user id here
-- is the 64-character hex digest carried in `x-user-id`, never a UUID.
--
-- So EVERY claim on a `code_pool` card failed with SQLSTATE 22P02, `invalid input syntax for type
-- uuid`, on the very first statement `claimPoolCode` runs - the `findClaimedCode` lookup - and the
-- route answered 500. Not a race, not a load-dependent edge: the feature could never have worked
-- once, and prod confirmed it, holding zero claimed rows against a live card. `shared_code` and
-- `text` cards were unaffected, which is why the tab looked healthy.
--
-- The column is widened to match every sibling. Nothing is converted: no row has ever been claimed,
-- because no INSERT of a real user id could pass the type. The partial unique index
-- `idx_partnership_codes_card_claimant` is rebuilt by ALTER TYPE and keeps its predicate, so the
-- idempotence guarantee `claimPoolCode` relies on survives untouched.
--
-- The unit tests never caught it because they mock the repository, so no type is ever exercised.
-- What catches this class now is a shared column-type invariant test - see
-- `partnerships.service.spec.ts` and `USER_ID_COLUMN` in the entity.
BEGIN;

ALTER TABLE partnership_codes
  ALTER COLUMN "claimedByUserId" TYPE varchar(255) USING "claimedByUserId"::varchar;

COMMIT;
