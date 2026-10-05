-- Migration 076: the salon a community is born with is named with an accent (e-acute twice, built
-- below with chr(233) so this file stays ASCII), as it is for every community created from now on
-- (DEFAULT_CHANNEL_NAME in channel.service.ts).
--
-- OWED TO THE USER'S GO BEFORE THE RELEASE THAT CARRIES IT: it rewrites a name members see.
--
-- WHAT COUNTS AS "NEVER RENAMED". Nothing records a rename, so the rule is the shape of the
-- default itself: the salon is named exactly 'general' AND was created with its community (within
-- one minute of the community row - the two inserts are one request) AND is public. A salon a
-- member named 'general' later fails the age test; one renamed to something else and back is
-- indistinguishable from the default, and renaming it is what its owner would want anyway.
-- Skipped where the accented name already exists, because (workspaceId, name) is unique.
--
-- Idempotent: after a run no row matches the name any more. "updatedAt" is left as it was - the
-- rename is not a member's edit.

UPDATE channels c
   SET name = 'g' || chr(233) || 'n' || chr(233) || 'ral'
  FROM channel_workspaces w
 WHERE w.id = c."workspaceId"
   AND c.name = 'general'
   AND c."isPrivate" = false
   AND c."createdAt" <= w."createdAt" + interval '1 minute'
   AND NOT EXISTS (
        SELECT 1 FROM channels o
         WHERE o."workspaceId" = c."workspaceId"
           AND o.name = 'g' || chr(233) || 'n' || chr(233) || 'ral'
   );
