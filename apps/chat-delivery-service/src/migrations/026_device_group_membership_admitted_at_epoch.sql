-- THE EPOCH A QUEUED WELCOME ADMITS A PENDING DEVICE AT (user, 2026-09-28).
--
-- A device added while its phone was dead is `pending` until its own join reports it, and the send
-- path queued for `active` rows only - so every frame sent in between skipped it, and a replay at
-- activation (DF2) re-sent what a five-minute window over the Redis history stream still held.
-- That replay is removed in the same change: a pending device holding this column is queued, at
-- send time, every frame sealed at or after it, read from each frame's clear MLS header.
--
-- Written by `sendWelcome` from the group's `activeEpoch` (both add flows have the commit accepted
-- before the Welcome goes out), cleared by every status transition. NULL on every existing row,
-- which is exactly the old behaviour for them: a device whose Welcome predates this column is
-- routed when it activates, as it was.
ALTER TABLE dm_device_group_memberships
  ADD COLUMN IF NOT EXISTS "admittedAtEpoch" integer;
