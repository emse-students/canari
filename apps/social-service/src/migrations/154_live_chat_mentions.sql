-- Migration 154: who a live chat line told of a mention (owner, 2026-11-09, docs/wiki/services/lives.md
-- "Mentions in the live chat").
--
-- "mentionedUserIds" is the set of accounts the server ADDRESSED for this line - the candidates the
-- client declared, narrowed to those who may see the live (`liveMentionRecipientsSql`). It is what
-- makes "one notice per person per author per minute" a count of durable rows rather than a clock,
-- and what makes the fan-out run once (only a line that is INSERTED notifies; a retried send that
-- finds its row does not). Ephemeral like the row: it goes with the live (C2).
--
-- Additive: one column with a default, no index (the window is read inside one live's rows by author,
-- already served by live_chat_messages_author_idx). Idempotent for CD.

ALTER TABLE live_chat_messages
  ADD COLUMN IF NOT EXISTS "mentionedUserIds" text[] NOT NULL DEFAULT '{}';
