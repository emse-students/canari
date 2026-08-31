-- The language a device reads, carried from the app that knows it to the one layer that composes a
-- sentence without being able to ask: `APNS_FALLBACK_BODY`, the alert an iPhone shows when the
-- Notification Service Extension does not run or cannot decrypt. Everything else on this path is
-- written BY the device, from `push_context.json`.
--
-- Nullable, and null reads as "not told": the fallback stays French, which is what every row said
-- before this column existed. Written by `POST /mls/push/register`, which the client re-issues when
-- the language changes because its skip predicate keys on the token AND the locale.
ALTER TABLE "push_token" ADD COLUMN IF NOT EXISTS "locale" varchar(5);
