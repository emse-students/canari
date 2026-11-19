## P2 - the live card follows the feed tab (owner, 2026-11-19)

target: 1.7.2

**Decided by the owner on 2026-11-19** ([decisions](owner-decisions-of-2026-11-19.md), item 41). The owner
saw a member's personal live under the "Organisations" tab and asked why. The cause: the live card sits at
the top of the feed **whatever the tab** (L5, `frontend/src/routes/posts/+page.svelte`, the `LiveFeedCard`
block). The tab does not filter it. Who may watch is unchanged and correct: a live follows the rule of a
post ([lives](../services/lives.md#who-may-watch-the-rule-of-a-post)).

**Owed:**
- **"Organisations" (`associations`):** the card lists association lives only (`associationId` set).
- **"Pour toi" (`foryou`) and "Campus" (`all`):** the card lists every live the reader may watch, personal
  and association, as today.
- **Where it is decided:** the filter is one predicate on the live's `associationId`, applied to the list
  the card already reads. It is not a second visibility rule: the server's `liveVisibleToUserSql` stays the
  only gate.
- **Tests and docs:** a component test per tab, and the L5 comment and
  [live](../frontend/modules/live.md) updated to say the card follows the tab.
