-- WP-60, THE CUT: every community, channel, member, role, invitation and message is deleted.
--
-- WHY A DELETE AND NOT A MIGRATION OF THE DATA. Every channel message ever written was sealed with
-- an epoch key the server derived from `channels.masterSecret`, which migration 041 has just
-- dropped. There is no key left to re-seal them under, and no device holds one either: a Graine
-- seed is minted by a SENDER, and no sender ever minted one for a message written before Graine
-- existed. Keeping the rows would leave every salon full of ciphertext nobody - not even its own
-- author - can ever open again, which reads as history right up until somebody scrolls to it. The
-- clean cut was decided 2026-08-17, and deleting everything silently at deploy on 2026-08-18.
--
-- SILENT ON PURPOSE. No in-app notice precedes it: the people concerned were warned out of band
-- before this shipped, and a notice rendered by a client that no longer has a community to show it
-- in would arrive after the fact anyway.
--
-- ORDER IS CHILD-FIRST, AND EVERY TABLE IS NAMED. No foreign keys join these (they were written
-- without them), so nothing cascades - and nothing would fail loudly if a table were left out,
-- which is exactly why each one is written here instead of trusted to a cascade that does not
-- exist. The distribution groups these communities own live in chat-delivery's schema and are
-- tombstoned by that service's own migration in the same deploy.
--
-- IDEMPOTENT BY LEDGER AND BY SHAPE. `schema_migrations` runs it exactly once; a deploy that dies
-- half way leaves it unrecorded and it re-runs, and a second pass over empty tables is a no-op.
-- It must NEVER be edited afterwards: an edited checksum warns but does not replay, so a change
-- here would silently do nothing on the only host that matters.
DELETE FROM channel_messages;
DELETE FROM channel_members;
DELETE FROM channel_roles;
DELETE FROM workspace_invites;
DELETE FROM channels;
DELETE FROM channel_workspaces;
