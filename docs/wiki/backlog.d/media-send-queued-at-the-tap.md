## P2 - a DM/group file is queued at the tap, like a text, and the pre-send media barrier goes

**What is wrong.** `handleSendChat` (`frontend/src/lib/composables/useMessaging.svelte.ts`, the media
branch) still awaits `waitForMessageQueueIdle('media send')` and `verifyCurrentUserMembership` BEFORE
it writes the placeholder and the outbox entry. On a stalled link that pre-send wait measured 18 s
(2026-10-31), and during it the tap had no visible effect: no bubble, no clock. A text is captured
into the outbox at the tap and never waits for this.

**What already shipped.** The duplicate this wait produced is fixed: the staged files are claimed in
the tick they are read, so a second Send during the barrier finds nothing (13 taps used to queue 13
copies of one video; the story is in `CHANGELOG.md`). The send is
still SLOW to show, which is what this entry is about.

**Why the barrier is a duplicate.** The outbox flush already takes both halves of it before every
send (`frontend/src/lib/utils/chat/outbox.ts`): `waitForMessageQueueIdle('outbox flush')` at the
start of a flush, and per entry the `isGroupHealthy` gate followed by `mlsService.isGroupActive`,
which retires an evicted group's entries and asks before a media entry pays its upload. The
composer-side barrier answers the same two questions a second time, earlier and slower, and its
answer can go stale before the flush runs anyway.

**What to build.**

1. Write the placeholder and the media outbox entry at the tap, exactly as the text path does
   (`sendChatMessage` -> `enqueueOutboxMessage`), keeping the order the code already pins: the file
   is READ before the placeholder, and a refused enqueue withdraws the placeholder
   (`useMessaging.mediaEnqueue.svelte.test.ts`).
2. Delete the composer-side barrier and its `media refused` branch. A group that is not usable yet is
   the outbox's to wait for, as it is for a text; a row awaiting re-admission is held by the same
   gate. Check what the `chat_send_session_establishing` banner becomes once nothing refuses here.
3. Keep the claim of the staging before the first await - it is what makes a second Send a no-op,
   whatever else moves.

**Tests owed with it.** A tap on a held link shows the bubble before the membership answer; the
`media refused` tests of `useMessaging.mediaEnqueue.svelte.test.ts` move to the outbox gate; the
composer test `ChatComposer.mediaSendInFlight.svelte.test.ts` keeps passing unchanged. Mechanism of
the outbox: [chat](../frontend/modules/chat.md#outbox-outbound-delivery).
