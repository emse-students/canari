## P3 - Two devices of one account joining a community at once: one exhausts its external-join attempts and loses a frame (LIST-RACE-1-W, 2026-10-27)

target: 1.9.0

Seen on dev `1.5.0-alpha.1`. W4 and W8 are two devices of ONE account, which a user with two devices
can produce by joining from both. They external-joined the community's key group in the same second.

- W8 was refused `concurrent_commit` twice, then joined at base 2.
- W4 was refused `epoch_mismatch` three times: base 0 at group 1, base 1 at group 2, base 2 at group 3.
  It reached `EXTERNAL_JOIN_MAX_ATTEMPTS` and logged
  `[GRAINE] could not join the distribution group of community ... (refused)`.
- 0.9 s later another path joined it at base 4. An application frame of epoch 4 then reached it at
  epoch 5: `[GRAINE] frame on ... is unreadable for good (past-epoch-application) - acknowledged; its
  seed comes back through a history request`.

The row still passed, but this is a heal after a race on the normal path, which the rules count as
a defect: the bounded retry lost to its own sibling's commits, and a frame was lost and had to be
recovered. The give-up line had appeared in no row since 2026-08-27
([cross-client-campaign](../cross-client-campaign.md)). Evidence: the run's W4 and W8 consoles
(`logs/consoles/LIST-RACE-1-W-2026-10-26T23-45-59-975Z-*`, W4 lines 123-171, in the rig's state
directory). Owed: say what serialises two joins of one account into one key group. That fact
deletes the overlap; a larger retry bound only widens it. Then re-measure with LIST-RACE-1-W, which
reproduces the pair. Not narrated: it stays dirt until fixed.

**Brief for an agent (batch 15, 2026-11-12; MLS and native - opus, adversarial review before each merge, every PR born `--draft`).** Answer first, in the wiki, what serialises two external joins of ONE account into one key group: read the key-group join path (`graine/distributionGroup.ts` `ensureJoined`, the native `mobile/key_group_join.rs`, and the server gate of WP-KEYGROUP-JOIN-GATE in social-service). Expected shape of the fix: the second device of an account does not external-join while a sibling's join of the same group is in flight - it waits for that commit and joins from its base, or is added by the sibling - decided from a fact the server already holds (the sibling's claim), never a larger retry bound. Then re-run LIST-RACE-1-W on the rig and read no give-up line and no past-epoch application frame.
