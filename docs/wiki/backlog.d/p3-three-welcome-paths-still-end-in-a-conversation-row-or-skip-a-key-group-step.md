## P3 - Three Welcome paths still end in a conversation row or skip a key-group step (2026-10-25)

target: 1.9.0

What wrote and then probed a key group's conversation row is fixed
([channel-encryption](../protocols/channel-encryption.md#a-key-groups-welcome-wrote-a-conversation-row-and-discovery-asked-its-roster---fixed-2026-10-25)).
Three paths are left, none built:

- **A key-group Welcome whose row is unreadable AND whose group this session does not name.**
  `handleWelcome` (`setupMessageHandler.ts`) classifies from `getGroupMeta` when it answers, and from
  `isDistributionGroup` when it does not (`null` = network failure or any non-2xx). With neither -
  typically a first Welcome before any community load - it takes the CONVERSATION path:
  `processWelcome`, a placeholder row, `upsertConversation`, and the drain announces it. Discovery
  purges that row at the next boot, but until then a seed carrier sits in the sidebar store. A
  policy choice, not a reorder: a Welcome is always acknowledged (its KeyPackage is consumed), so
  "could not read the kind" needs a decision - hold the Welcome unacknowledged until the row is
  readable, or install it without a row and classify it afterwards. Unmeasured: how often the meta
  read fails on a Welcome.
- **A Welcome owed while `ensureDistributionGroupFor` (`utils/graine/distributionGroup.ts`)
  answered `false`** leaves `askForHistory` /
  `reconcileRoster` unrun once that Welcome installs: `handleDistributionWelcome` installs and
  promotes, and nothing re-runs the steps the ensure skipped. Found by reading (review of #2408);
  the steps' owner should be the install, not the ensure.
- **A Welcome for a group deleted server-side, or one refused `CannotDecryptOwnMessage`, is still
  announced.** `handleWelcome` returns `true` (ACK) on both, and `processQueue` fires
  `onWelcomeProcessed` on any non-throwing Welcome, whose listener writes an `active` row for a group
  that has none. The drain needs the handler's verdict ("installed a conversation"), not "did not
  throw". Found by reading (review of #2408).

Re-read 2026-11-11 (batch 12): still real - none of the three paths is built. Re-read again 2026-12-11.
