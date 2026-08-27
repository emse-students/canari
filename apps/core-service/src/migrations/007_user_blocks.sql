-- Migration 007: blocking a person.
--
-- Asked for by the user on 2026-08-27, and deliberately NARROW: a block stops the blocked person
-- from REACHING the blocker for something new - finding them in a target picker, opening a 1-to-1,
-- pulling them into a group or a private salon. It does not touch what already exists. Shared
-- communities, shared groups, an existing conversation and the two people's posts are all unchanged,
-- because a block is between two people and not a moderation verdict.
--
-- WHY THE TABLE LIVES HERE AND EVERY SERVICE READS IT. A block is a fact about two accounts, so it
-- belongs beside `users`, in core-service, which owns the routes that manage it. But it has to be
-- ENFORCED where it is bypassed: hiding someone from search stops nothing, since a known uuid is
-- enough to open a conversation. So chat-delivery reads it before adding a member to a group, and
-- social-service before letting someone invite another into a private salon. All three share
-- `auth_db`, and reading another service's table with plain SQL is what this repo already does a
-- dozen times over (`SELECT ... FROM users` from social-service). An internal HTTP hop on the
-- critical path of every group creation would buy a boundary and cost a round trip.
--
-- SYMMETRIC BY CONSTRUCTION. Every consumer asks "is there a row between these two, either way",
-- never "did A block B". That is what makes the two people disappear from each other's pickers with
-- one row, and what stops the blocker from re-opening a conversation they closed.
--
-- No cascade to `users`: `users.id` is the OIDC subject, a varchar and not a uuid, and account
-- deletion already sweeps this table explicitly (core-service `deleteUser`).

CREATE TABLE IF NOT EXISTS user_blocks (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "blockerId"  VARCHAR(255) NOT NULL,
    "blockedId"  VARCHAR(255) NOT NULL,
    "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "CHK_user_blocks_not_self" CHECK ("blockerId" <> "blockedId")
);

-- One row per ordered pair: blocking twice is the same block, and the upsert relies on this.
CREATE UNIQUE INDEX IF NOT EXISTS "IDX_user_blocks_pair"
    ON user_blocks ("blockerId", "blockedId");

-- The enforcement question is asked in both directions on every group add and every invitation,
-- so the reverse lookup needs its own index - the composite one above only serves the blocker side.
CREATE INDEX IF NOT EXISTS "IDX_user_blocks_blocked"
    ON user_blocks ("blockedId");
