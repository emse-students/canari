-- Deleting a salon deletes it, and the two soft-delete tombstones nothing can set any more go too.
--
-- A CHANNEL'S DELETE ARCHIVED. `DELETE /channels/:id` set `archived = true` and, in the same call,
-- destroyed the salon's key-distribution group - so a private salon's messages survived as
-- ciphertext no client keeps a seed for. Invisible to every listing, unreachable by every route,
-- with no un-archive anywhere in the service and no way to remove the rows short of deleting the
-- whole community. That is the exact shape 042 removed one scope up, and the reasoning transfers
-- without a word changed: recoverability that only recovers unreadable rows is not recoverability.
-- The dialog has said "Supprimer definitivement le canal #x ?" since the first version of the
-- string, so nothing about what a person was promised changes here - only whether it was true.
--
-- BOTH `archived` COLUMNS ARE DEAD, and the channel's was the last writer of either. 042 made
-- community deletion a real delete and left `channel_workspaces.archived` behind with every read
-- path still filtering on it; after this change nothing in the service assigns `archived` at all,
-- so both columns are constants that a dozen `WHERE` clauses were still consulting. A column no
-- code can set does not guard anything - it only outlives the mechanism it was written for, which
-- is how the comment above `getUserWorkspaces` came to claim membership rows survive a deletion
-- two days after `hardDeleteWorkspace` started removing them.
--
-- MEASURED ON PROD BEFORE DROPPING, not assumed: `SELECT archived, count(*)` over both tables
-- returned a single `f` row each - 14 channels, 1 community, zero archived. So the DELETE below
-- removes nothing today. It is written anyway because this file is not only run here, and because
-- an archived salon reaching the drop would otherwise be silently RESURRECTED into every sidebar
-- by the removal of the filter that was hiding it - the one outcome worse than leaving it buried.
--
-- Idempotent and safe to re-run: the delete is a no-op once the rows are gone, and both drops are
-- `IF EXISTS`. Ordered delete-then-drop, since the predicate lives in the column being dropped.

-- The messages first: `channel_messages` has no foreign key onto `channels` (nothing in this
-- schema does), so nothing cascades and the rows would outlive their salon as unattributable
-- ciphertext - the orphan shape this whole migration is about.
DELETE FROM channel_messages
WHERE "channelId" IN (SELECT id FROM channels WHERE archived = true);

DELETE FROM channels WHERE archived = true;

-- No equivalent sweep for `channel_workspaces`. 042 emptied that table outright, and every
-- community created since has been deleted by `hardDeleteWorkspace`, which removes the row rather
-- than flagging it - so no archived community can exist to resurrect. This is the column only.
ALTER TABLE channels DROP COLUMN IF EXISTS archived;
ALTER TABLE channel_workspaces DROP COLUMN IF EXISTS archived;
