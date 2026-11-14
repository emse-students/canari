## P3 - Id validators are sized by hand, not from the rule that mints the id (audit of 2026-10-28)

target: 1.10.0

- Audited after the revoked-leaves 400 ([durable-rules](../durable-rules.md#a-validators-bound-is-derived-from-the-generator-of-the-value-and-its-spec-uses-a-value-of-real-length)):
  every other `sanitizeQueryValue` field in chat-delivery fits its generator today (UUIDs, 64-hex
  user ids, device ids of at most ~87 characters).
- The latent gap: a user id is minted under "visible ASCII, no ':'" with NO length bound
  (`core-service/src/users/user-id.ts`), the device id EMBEDS it, and the services refuse a user id
  over 128 or outside `[a-zA-Z0-9_.:@-]`, and a device id outside social-service's
  `[A-Za-z0-9_-]{1,128}`. A user id of more than ~40 characters, or holding `.` or `@`, mints a
  device that some route refuses. Holds today only because the provider's ids are 64-hex.
- Owed: one shared shape for the user id and the device id, asserted by the minting side and every
  validator, rather than four regexes that agree by accident.

**Plan (batch 15, 2026-11-12) - a count first, then one contract.** (1) A read-only count of user ids outside `^[a-zA-Z0-9_-]{1,64}$` on each estate (a column of `users`; the ids are not printed). (2) If 0: a `libs/contracts/user-id.json` like `device-id.json`, asserted by the mint rule (`core-service/src/users/user-id.ts`) and by every user-id validator's spec, and the device-id pattern derived from it. If not 0: the ids outside it are the decision, before any rule is tightened - the mint rule deliberately lets an older plain ASCII id keep signing in. No agent needed for (2).
