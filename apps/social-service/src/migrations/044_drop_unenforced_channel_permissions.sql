-- Removes the two permissions that were never enforced, and the column that never decided anything.
--
-- `channel.access` and `channel.send` sat in the registry and in the community permission grid from
-- the start and were read by NOTHING. They are not being wired up, they are being deleted, because
-- wiring them would have been the mistake: a public salon is visible to every member and a private
-- one to the people in it, so a per-role read permission can only agree with that or contradict it;
-- and `writePolicy` is decided per salon, which is strictly more expressive than one switch across
-- the whole community. The reasoning in full is in `permissions.ts`.
--
-- `channels."allowedRoles"` goes with them. It has been written as `''` at every creation site and
-- read by nothing since the column existed - access to a private salon is per person
-- (`allowedUsers`), which is what an invitation actually names.
--
-- Idempotent and safe to re-run: the array rewrite is a filter over values that may already be
-- absent, and the drop is `IF EXISTS`. Nothing here can remove a permission still in use, because
-- the two names below appear in no other row and in no code path.

-- The stored role rows. `permissions` is TypeORM `simple-array`, i.e. a comma-joined text column,
-- so it is split, filtered and re-joined rather than pattern-replaced: a `replace()` on the text
-- would also match `channel.send` inside a longer key the day one is added.
UPDATE channel_roles
SET permissions = COALESCE(
  (
    SELECT string_agg(p, ',' ORDER BY ord)
    FROM unnest(string_to_array(permissions, ',')) WITH ORDINALITY AS t(p, ord)
    WHERE p NOT IN ('channel.access', 'channel.send', 'SEND_MESSAGES')
  ),
  ''
)
WHERE permissions ~ '(^|,)(channel\.access|channel\.send|SEND_MESSAGES)(,|$)';

-- There is no second table to clean. The grid's "overrides" are a VIEW of the list above - one row
-- per role, its permissions comma-joined - so the rewrite above is the whole of it.

ALTER TABLE channels DROP COLUMN IF EXISTS "allowedRoles";
