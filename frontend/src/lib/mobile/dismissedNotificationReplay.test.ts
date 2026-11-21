import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A DISMISSAL MUST OUTLIVE THE PROCESS THAT TOOK IT.
 *
 * ## What this is for
 *
 * The notification shade was the only record of what had been announced, and the builder asked it:
 * `MessagingStyle` re-injects the messages of the post already showing, so a second trigger for the
 * same message recognises itself there and refreshes without alerting again. That closed the
 * side-by-side duplicate (2026-09-18) and it closes nothing here, because the shade answers a
 * strictly weaker question than the one that matters. "Is it still showing" goes false when the user
 * swipes - and when `MainActivity.onResume` cancels every message notification, which it does on
 * every launch. "Has the user been told" stays true through both.
 *
 * So a message redelivered after a dismissal looked, to the builder, exactly like a first arrival.
 * And the launch is precisely when a redelivery happens: a push the app was never awake to
 * acknowledge is still queued, and the drain hands it back. Reported 2026-09-18 (`G2`): *"une
 * notification que j'ai ignoree se raffiche au lancement de l'app"*.
 *
 * ## Why it is a SET and not a watermark
 *
 * `sentAt` is the SENDER'S clock. Nothing synchronises the senders in a group, so "the newest
 * instant already announced" would swallow a genuinely new message from anybody whose clock runs
 * behind - a correctness bug traded for a duplicate. The question is "have I announced THIS
 * message", and only a set answers it. It is bounded, and it is keyed the same way the shade is
 * matched - the conversation plus the SENDER'S instant - so one rule covers the live post and the
 * dismissed one.
 *
 * ## Why the body is not in the key
 *
 * The two triggers render the same message into different text: a push runs `renderMentions` over
 * the plaintext, a WebSocket frame runs `getPreviewText`, which LABELS a media message, a poll and a
 * bare link instead of quoting them. A key holding the body could therefore never match across the
 * two for anything but plain prose. The in-shade match shipped with that weakness on 2026-09-18 and
 * is corrected here with it.
 *
 * ## Why the assertion is on the SOURCE
 *
 * `frontend/src-tauri/gen/android/app/src/test/java/.../PushDecryptLadderTest.kt` exists and nothing
 * runs it - no workflow, no Makefile target invokes Gradle's unit tests. The convention that DOES
 * run is this directory: vitest holding the native sources to a rule, as `nativeStrings`,
 * `androidFcmManifest` and `pushForegroundHandover` already do.
 *
 * ## What it cannot see
 *
 * It reads text. It proves the record is written and consulted, not that a phone stays quiet - that
 * is owed on hardware, and `docs/wiki/device-verification.md` carries the check.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SERVICE = resolve(
  here,
  '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt'
);
const source = readFileSync(SERVICE, 'utf8');

describe('the native builder remembers what it has already announced', () => {
  it('keeps the record in SharedPreferences, which is what survives the process', () => {
    expect(source).toMatch(/ALERTED_PREFS\s*=\s*"canari_alerted_messages"/);
  });

  it('commits it rather than applying it, because the case served is a kill', () => {
    // `apply()` is asynchronous. The whole point of the record is the app dying between the
    // notification and the next launch, which is exactly when an in-flight apply is lost.
    const remember = source.slice(source.indexOf('private fun Context.rememberAlerted'));
    expect(remember.slice(0, 800)).toContain('.commit()');
  });

  it('bounds the record, so it cannot grow without end', () => {
    expect(source).toMatch(/MAX_ALERTED_KEYS\s*=\s*\d+/);
    expect(source).toContain('while (kept.size > MAX_ALERTED_KEYS)');
  });

  it('is a SET of messages, not a watermark over an unsynchronised sender clock', () => {
    // A `sentAt <= somethingStored` comparison is the shape being refused here: it would silence a
    // new message from a sender whose clock runs behind. Membership is the only safe predicate.
    expect(source).toContain('hasAlreadyAlerted(alertedKey)');
    expect(source).not.toMatch(/sentAt\s*<=\s*\w*[Ww]atermark/);
  });

  it('identifies a message by the sender instant, never by text two renderers disagree on', () => {
    expect(source).toContain('private fun alertedKey(notifKey: String, sentAt: Long): String');
    expect(source).not.toContain('body.hashCode()');
  });

  it('matches the shade on the instant alone, for the same reason', () => {
    expect(source).toContain(
      'val alreadyPosted = sentAt > 0 && style.messages.any { it.timestamp == stamp }'
    );
  });

  it('asks the record only where a sender stamp exists, never guessing for a reaction or a salon', () => {
    // Both of those reach the builder with `sentAt = 0` - a reaction has no message instant of its
    // own to offer, and the channel push payload carries no timestamp field at all.
    expect(source).toContain('if (sentAt > 0) alertedKey(notifKey, sentAt) else null');
  });

  it('records AFTER the post, so a builder that threw leaves nothing suppressing the retry', () => {
    // The post is guarded by the read-elsewhere check (2026-11-20), so the notify is no longer the
    // line right above the record: what holds is the order - post, then record - and a post refused
    // as already read returns BEFORE the record, leaving nothing to suppress a later banner.
    const record = source.indexOf('// WRITTEN AFTER THE POST');
    expect(record).toBeGreaterThan(-1);
    expect(source.slice(record, record + 400)).toContain('rememberAlerted(it)');
    // 2400: the post's outcome record (`finally`, #3914) sits between the two.
    const before = source.slice(record - 2400, record);
    expect(before).toContain('manager.notify(notifId, notif)');
    const refused = before.indexOf('if (readElsewhere)');
    expect(refused).toBeGreaterThan(-1);
    expect(before.slice(refused)).toContain('return 0L');
  });
});

/**
 * A POST COVERED BY A READ ON ANOTHER DEVICE TOUCHES NOTHING (re-review of #3912, 2026-11-20).
 *
 * The channel switch removed the conversation's CURRENT banner before the read-elsewhere check, so
 * a covered late post - an older mention already read on the web - took a newer message's banner
 * down and then posted nothing. The decision itself is JVM-tested (`ReadElsewhereMarksTest`); what
 * this pins is that the builder hands it EVERY side effect: the switch's cancel lives inside the step
 * `postUnlessRead` runs, and the early check comes before the first side effect.
 */
describe('the builder decides "already read elsewhere" before touching the shade', () => {
  const builderStart = source.indexOf('fun Context.showMessageNotification(');
  const builder = source.slice(builderStart);

  it('asks the record before the id is minted, and nothing in between touches the shade', () => {
    const early = builder.indexOf('READ_ELSEWHERE.covers(groupId, sentAt, serverAt)');
    expect(early).toBeGreaterThan(-1);
    expect(early).toBeLessThan(builder.indexOf('getStableNotifId(this, notifKey)'));
  });

  it('runs the channel-switch cancel only inside the guarded post', () => {
    const step = builder.indexOf('val postToShade = {');
    expect(step).toBeGreaterThan(-1);
    const stepBody = builder.slice(
      step,
      builder.indexOf('}', builder.indexOf('manager.notify', step))
    );
    expect(stepBody).toContain('if (switchesChannel) manager.cancel(notifId)');
    expect(builder.slice(step)).toContain('READ_ELSEWHERE.postUnlessRead(');
    expect(builder.slice(step, step + 1200)).toContain('postToShade,');
    // No cancel of the conversation's banner anywhere before that step.
    expect(builder.slice(0, step)).not.toContain('manager.cancel(notifId)');
  });
});

/**
 * A READ IS WEIGHED AGAINST THE SHADE, NOT AGAINST THE WEBVIEW'S ROW (round-3 review of #3912).
 * The row can lag behind the shade, so the cancel compares the mark with the instants this side
 * stamped on each line - `ReadElsewhereMarksTest` runs the decision; this pins the wiring.
 */
describe('the read-elsewhere cancel reads the shade inside its critical section', () => {
  it('stamps both instants on every line it posts', () => {
    expect(source).toContain('newMessage.extras.putLong(LINE_SENT_AT, sentAt)');
    expect(source).toContain('newMessage.extras.putLong(LINE_SERVER_AT, serverAt)');
  });

  // Round-5 review: the id was resolved only on the shade's branch, so the usual case cancelled -1.
  // The cancel now takes the id of the banner it weighed, whichever source supplied it.
  it('cancels the id of the banner it weighed, looked up inside the critical section', () => {
    const fn = source.slice(source.indexOf('internal fun cancelConversationNotification('));
    const body = fn.slice(0, fn.indexOf('GENERIC_BANNERS.groupCleared(groupId)'));
    // One shade lookup and one cancel-by-id, handed to BOTH dismissals - with a mark and without.
    expect(body).toContain(
      'val shade = { prefs.getInt(groupId, -1).takeIf { it != -1 }?.let { shadeBannerOf(manager, it) } }'
    );
    expect(body).toContain(
      'READ_ELSEWHERE.recordThenCancel(groupId, read, shade, holds, repost, cancelById)'
    );
    expect(body).toContain(
      'READ_ELSEWHERE.withdraw(groupId, keepPendingReply, stableId, shade, holds, repost, cancelById)'
    );
    expect(body).toContain('manager.cancel(id)');
    expect(body).not.toContain('manager.cancel(notifId)');
    expect(body).not.toContain('READ_ELSEWHERE.forget(');
  });

  // Device reading of #3912 (item 2): the silent-from-self push removed a banner whose reply was
  // still queued. `ReadElsewhereMarksTest` runs the rule; this pins that the push asks for it.
  it("the push's silent-from-self cancel keeps a banner holding a pending reply", () => {
    const at = source.indexOf('FCM silent from self -> cancelling notification');
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 600)).toContain(
      'cancelConversationNotification(this, groupId, keepPendingReply = true)'
    );
  });

  it('a WebSocket post asks the record before the avatar and the generic ledger', () => {
    const fn = source.slice(source.indexOf('fun notifyMessageFromWebSocket('));
    const covers = fn.indexOf('READ_ELSEWHERE.covers(groupId, sentAt, serverAt)');
    expect(covers).toBeGreaterThan(-1);
    expect(covers).toBeLessThan(fn.indexOf('GENERIC_BANNERS.realPosted('));
    expect(covers).toBeLessThan(fn.indexOf('context.fetchAvatar(senderId)'));
  });
});

/**
 * WHAT A READ IS WEIGHED AGAINST (round-4 review of #3912): the lines this process handed to
 * `notify`, recorded with the post - the shade lags a `notify`, so it is asked only when this process
 * posted nothing. `ReadElsewhereMarksTest` runs the decision on an asynchronous shade; this pins the
 * builder's side of it.
 */
describe('the builder records what it posted and keeps the stamps current', () => {
  it('builds on the record under its lock and hands the posted banner to it', () => {
    const fn = source.slice(source.indexOf('fun Context.showMessageNotification('));
    const lock = fn.indexOf(
      'val (postedStamp, postedAlertedKey) = try { synchronized(READ_ELSEWHERE.lock) {'
    );
    expect(lock).toBeGreaterThan(-1);
    // The banner a post re-injects comes from the record (the shade only when there is none)...
    const held = fn.indexOf('READ_ELSEWHERE.bannerOf(groupId) { shadeBannerOf(manager, notifId) }');
    expect(held).toBeGreaterThan(lock);
    // ...and nothing before the lock reads the shade.
    expect(fn.slice(0, lock)).not.toContain('activeNotifications');
    expect(fn).toContain(
      'ReadElsewhereMarks.Banner(notifId, postChannel, style.messages.toList(), notif)'
    );
  });

  it('marks the pending reply explicitly, never by its name, so no read covers it', () => {
    expect(source).toContain('extras.putBoolean(LINE_PENDING_REPLY, true)');
    const fn = source.slice(source.indexOf('private fun lineOfMessage('));
    expect(fn.slice(0, 700)).toContain('stamps.getBoolean(LINE_PENDING_REPLY, false)');
    expect(fn.slice(0, 700)).not.toContain('.name');
  });

  it("forgets the record on the user's swipe of THAT banner, and when every banner is cleared", () => {
    // ONE builder of a conversation banner sets the delete intent, and BOTH posts - the message
    // and the pending reply's re-post (device reading of #3912: the re-post had none) - use it.
    expect(source.split('.setDeleteIntent(').length - 1).toBe(1);
    const helper = source.slice(source.indexOf('private fun conversationBanner('));
    expect(helper.slice(0, 400)).toContain(
      'builder.setDeleteIntent(bannerDismissedIntent(context, groupId, notifId)).build()'
    );
    const show = source.slice(source.indexOf('fun Context.showMessageNotification('));
    expect(show).toContain(
      'val notif = if (isReactionNotif) notifBuilder.build() else conversationBanner(this, notifBuilder, groupId, notifId)'
    );
    // EVERY post on a conversation's stable id goes through it (round-7 review): a `notify` in a
    // function not listed below as posting something else must hand over `conversationBanner(...)`
    // or a `notif` that function built with it. A new poster fails here until it is classified.
    const notConversation = new Set([
      'showIncomingCallNotification',
      'refreshBadgeSummary',
      'postOutboxNudge',
      'showNewDeviceNotification',
      'showWakeUnavailableNotification',
      'showSimpleNotification',
    ]);
    const posters: string[] = [];
    for (const m of source.matchAll(/manager\.notify\(([^)]*?)(\)|$)/gm)) {
      const before = source.slice(0, m.index);
      const fns = [...before.matchAll(/fun (?:\w+\.)?(\w+)\(/g)];
      const name = fns[fns.length - 1][1];
      if (notConversation.has(name)) continue;
      posters.push(name);
      const fn = source.slice(fns[fns.length - 1].index);
      const call = source.slice(m.index, source.indexOf('\n', m.index));
      if (call.includes('conversationBanner(')) continue;
      expect(call).toMatch(/manager\.notify\([\w.]+, notif\)/);
      const built = fn.slice(
        fn.indexOf('val notif = '),
        fn.indexOf('\n', fn.indexOf('val notif = '))
      );
      expect(built).toContain('conversationBanner(');
      expect(fn.indexOf('val notif = ')).toBeGreaterThan(-1);
      expect(fn.indexOf('val notif = ')).toBeLessThan(m.index - fns[fns.length - 1].index);
    }
    expect(posters.sort()).toEqual([
      'rebuildBanner',
      'repostReplyPending',
      'showMessageNotification',
    ]);
    expect(source).toContain('putExtra(EXTRA_BANNER_NOTIF_ID, notifId)');
    expect(source).toContain('if (READ_ELSEWHERE.forget(groupId, notifId)) {');
    // The cancels and the forget are one step under the lock a post holds.
    const all = source.slice(source.indexOf('fun cancelAllMessageNotifications('));
    const lock = all.indexOf('synchronized(READ_ELSEWHERE.lock) {');
    expect(lock).toBeGreaterThan(-1);
    expect(all.indexOf('manager.cancel(sbn.id)')).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(all.indexOf('manager.cancel(sbn.id)'));
    // ...and what the record holds is cancelled by id there too (round-7 review, S1) - except a
    // banner the platform holds, updated and kept (round-12 review, S-a).
    const forget = all.indexOf('READ_ELSEWHERE.forgetAll(');
    expect(forget).toBeGreaterThan(-1);
    expect(forget).toBeLessThan(all.indexOf('CallRingPlayer.rings'));
    // ONE snapshot answers every "held?" of the sweep (round-13 review).
    expect(all).toContain(
      'val heldIds = snapshot.filter { isHeldByDirectReply(it.notification) }.map { it.id }.toSet()'
    );
    expect(all.slice(forget, forget + 400)).toContain('holds = { it in heldIds }');
    expect(all).toContain(
      'if (isHeldByDirectReply(sbn.notification)) held += sbn.id else manager.cancel(sbn.id)'
    );
    // THE RECORD FIRST, then the FRESH copy (round-14 review, B2): a banner forgetAll re-posted
    // and kept may read as released at once, and must not be cancelled under its record.
    const release = all.indexOf('for (id in held) releaseUnrecordedHold(context, manager, id)');
    expect(release).toBeGreaterThan(forget);
    expect(all).not.toContain('cancelledByRecord');
    const unrecorded = source.slice(source.indexOf('private fun releaseUnrecordedHold('));
    const recorded = unrecorded.indexOf(
      'if (groupId != null && READ_ELSEWHERE.bannerOf(groupId) { null } != null) return'
    );
    const fresh = unrecorded.indexOf('if (!holdsDirectReply(manager, notifId)) {');
    expect(recorded).toBeGreaterThan(-1);
    expect(fresh).toBeGreaterThan(recorded);
    expect(fresh).toBeLessThan(unrecorded.indexOf('rebuildBanner('));
    // The app is in front: the re-post that ends a hold is EMPTY (round-15 review, S2).
    expect(unrecorded).toContain('rebuildBanner(context, manager, groupId)(banner, emptyList())');
    const marksSource = readFileSync(
      resolve(dirname(SERVICE), 'push/ReadElsewhereMarks.kt'),
      'utf8'
    );
    expect(marksSource).toContain(
      'kept[conversationId] = repost(conversationId, banner, emptyList()) ?: banner'
    );
  });

  // Round-13 review (S1): a channel switch cancels the old post - an app cancel, dropped on a
  // banner the platform holds, which then re-enqueues the old record over the new line.
  it('never sends a channel switch cancel to a held banner', () => {
    const fn = source.slice(source.indexOf('fun Context.showMessageNotification('));
    const shade = fn.indexOf('val postToShade = {');
    expect(shade).toBeGreaterThan(-1);
    const body = fn.slice(shade, fn.indexOf('\n                }', shade));
    expect(body.split('manager.cancel(').length - 1).toBe(1);
    expect(body).toContain('if (switchesChannel) manager.cancel(notifId)');
    const held = fn.indexOf(
      'val heldByReply = held != null && channel != CHANNEL_REACTIONS && holdsDirectReply(manager, notifId)'
    );
    const channel = fn.indexOf(
      'val postChannel = if (heldByReply) held?.channelId ?: channel else channel'
    );
    const switches = fn.indexOf('held.channelId != postChannel');
    expect(held).toBeGreaterThan(-1);
    expect(channel).toBeGreaterThan(held);
    expect(switches).toBeGreaterThan(channel);
    expect(switches).toBeLessThan(shade);
    expect(fn).toContain('NotificationCompat.Builder(this, postChannel)');
  });

  it('restamps a re-injected line when the second trigger knows the server instant', () => {
    const fn = source.slice(source.indexOf('fun Context.showMessageNotification('));
    const restamp = fn.indexOf('THE SECOND TRIGGER MAY KNOW MORE');
    expect(restamp).toBeGreaterThan(-1);
    expect(fn.slice(restamp, restamp + 900)).toContain(
      'it.extras.putLong(LINE_SERVER_AT, serverAt)'
    );
  });

  it('a dismissal with no mark ends with nothing to do once the banner is gone', () => {
    const fn = source.slice(source.indexOf('internal fun cancelConversationNotification('));
    const none = fn.indexOf('ReadElsewhereMarks.Withdrawal.NONE ->');
    expect(none).toBeGreaterThan(-1);
    const branch = fn.slice(none, fn.indexOf('ReadElsewhereMarks.Withdrawal.CANCELLED', none));
    expect(branch).toContain('return');
    expect(branch).not.toContain('Log.i(');
    expect(branch).not.toContain('Log.w(');
  });

  // Round-7 review (B1): only the quick reply's first try cleared the "not sent yet" line; a reply
  // delivered later by the retry worker or a push-woken drain kept it for good.
  it('every drain clears the pending notice of what it delivered', () => {
    // ONE drain body, reached only through `drainOutboxBackground` - which every caller uses.
    expect(source.split('drainOutboxLocked(').length - 1).toBe(2);
    const drain = source.slice(source.indexOf('internal fun drainOutboxBackground('));
    const body = drain.slice(0, drain.indexOf('private val OUTBOX_LOCK'));
    expect(body).toContain('replyDelivered(context, entry.groupId, entry.id)');
    const locked = source.slice(source.indexOf('private fun drainOutboxLocked('));
    const lockedBody = locked.slice(0, locked.indexOf('private fun encryptQueuedMessages('));
    expect(lockedBody).toContain('delivered.add(entry)');
    // Round-10 review (B1): an awaited reply's delivery is recorded AT THE SEND, inside the body
    // the outbox lock covers - never after it is released, where thread scheduling decided.
    const send = lockedBody.indexOf('delivered.add(entry)');
    const record = lockedBody.indexOf('AWAITED_REPLIES.delivered(entry.id, receivedAt)');
    expect(send).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(send);
    expect(record - send).toBeLessThan(500);
    expect(body).not.toContain('AWAITED_REPLIES.delivered(');
    const outer = body.slice(0, body.indexOf('for (entry in delivered)'));
    const underLock = outer.slice(outer.indexOf('synchronized(OUTBOX_LOCK) {'));
    expect(underLock).toContain('val left = drainOutboxLocked(');
    // The retry worker and the push-woken drains go through it.
    const worker = readFileSync(resolve(dirname(SERVICE), 'OutboxRetryWorker.kt'), 'utf8');
    expect(worker).toContain('CanariFirebaseMessagingService.drainOutbox(');
    // ...only with a network (#3912 F2): a drain run offline must not spend one of its attempts,
    // and a failed drain below the cap is a retry, never a failure.
    const enqueue = worker.slice(worker.indexOf('fun enqueueIfHealthy('));
    const build = enqueue.indexOf('.build()\n            workManager.enqueueUniqueWork(');
    expect(build).toBeGreaterThan(-1);
    expect(enqueue.slice(0, build)).toContain(
      '.setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())'
    );
    // ...under ONE unique name, each enqueue owed a drain after it (round-11 review, S4), and the
    // earlier builds' unconstrained requests cancelled once, by their class tag, BEFORE it.
    const unique = enqueue.indexOf(
      'workManager.enqueueUniqueWork(UNIQUE_WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, request)'
    );
    const legacy = enqueue.indexOf(
      'workManager.cancelAllWorkByTag(OutboxRetryWorker::class.java.name).result.get()'
    );
    expect(legacy).toBeGreaterThan(-1);
    expect(unique).toBeGreaterThan(legacy);
    expect(worker).not.toContain('.enqueue(request)');
    // ...and it ends on durable state, never on a count (`OutboxRetryTest`): a drain whose
    // leftovers can all still go is a retry, one refused for good is the nudge.
    expect(worker).not.toContain('MAX_DRAIN_ATTEMPTS');
    expect(worker).toContain('OutboxRetry.Decision.RETRY -> {');
    expect(worker).toContain('OutboxRetry.Decision.GIVE_UP -> {');
    expect(source).toContain('drainOutboxBackground(this, this, drainCtx)');
    // The pending line names its message.
    expect(source).toContain('extras.putString(LINE_PENDING_REPLY_ID, messageId)');
    expect(source).toContain('pendingReplyId = stamps.getString(LINE_PENDING_REPLY_ID)');
  });

  // Round-8 review: the rebuild after a late delivery is silent, has no fallback sender, and
  // casts its template with a check; a re-post racing a delivery is refused under the record lock.
  it('rebuilds silently after a delivery and refuses a re-post the delivery came before', () => {
    const fn = source.slice(source.indexOf('private fun replyDelivered('));
    const body = fn.slice(0, fn.indexOf('private fun rebuildBanner('));
    expect(body).toContain('repost = rebuildBanner(context, manager, groupId)');
    const rebuild = source.slice(source.indexOf('private fun rebuildBanner('));
    const rebuildBody = rebuild.slice(0, rebuild.indexOf('internal fun answerReplyNotification('));
    expect(rebuildBody).toContain('.setOnlyAlertOnce(true)');
    expect(rebuildBody).toContain('held.posted as? android.app.Notification');
    expect(rebuildBody).not.toContain(' as android.app.Notification');
    expect(rebuildBody).not.toContain('Person.Builder()');
    expect(rebuildBody).toContain('return@rebuild null');
    // What it draws IS `kept` (round-15 review, S1): the style is set on every path - the
    // template's own would redraw its old lines - and an empty conversation drops its text too.
    const style = rebuildBody.indexOf(
      'val style = NotificationCompat.MessagingStyle(previous.user)'
    );
    const setStyle = rebuildBody.indexOf('.setStyle(style)');
    expect(style).toBeGreaterThan(-1);
    expect(setStyle).toBeGreaterThan(style);
    expect(rebuildBody.slice(0, setStyle)).not.toContain('if (kept.isEmpty()');
    expect(rebuildBody).toContain('if (kept.isEmpty()) builder.setContentText(null)');
    expect(rebuildBody).toContain(
      'ReadElsewhereMarks.Banner(held.notifId, held.channelId, style.messages.toList(), notif)'
    );
    const repost = source.slice(source.indexOf('internal fun repostReplyPending('));
    const lock = repost.indexOf('synchronized(READ_ELSEWHERE.lock) {');
    const asked = repost.indexOf('AWAITED_REPLIES.deliveredAt(messageId)?.let { receivedAt ->');
    expect(lock).toBeGreaterThan(-1);
    expect(asked).toBeGreaterThan(lock);
    expect(asked).toBeLessThan(repost.indexOf('manager.notify('));
    // The delivered branch hands the receive time back, it does not just return.
    expect(repost.slice(asked, asked + 400)).toContain('return receivedAt');
    // A late delivery is not a read: its cancel leaves the reaction notification alone.
    expect(body).not.toContain('reactionNotifKey(');
  });

  // Round-9 review (B1): a reply another drain delivered while the user was replying from the
  // banner left the spinner running, with no action. It is the first-try success: one function,
  // reached from both branches, cancels and sends the watermark.
  it('a quick reply delivered by any drain runs the one success action', () => {
    const receiver = readFileSync(
      resolve(dirname(SERVICE), 'CanariNotificationActionReceiver.kt'),
      'utf8'
    );
    const handle = receiver.slice(receiver.indexOf('private fun handleReply('));
    const fn = handle.slice(0, handle.indexOf('private fun replyAnswered('));
    // Awaited before it is queued, settled whatever happens. Each index is asserted present first:
    // a deleted call reads -1, which is less than any index.
    const awaited = fn.indexOf('awaitReplyDelivery(messageId)');
    const queued = fn.indexOf('enqueueOutboxMirror(');
    expect(awaited).toBeGreaterThan(-1);
    expect(queued).toBeGreaterThan(-1);
    expect(awaited).toBeLessThan(queued);
    // A drain that throws still ends in the decision (round-10 review, S5).
    const drain = fn.indexOf('drainOutboxBackground(');
    expect(drain).toBeGreaterThan(-1);
    expect(fn.slice(drain, fn.indexOf('val receivedAt = ', drain))).toContain(
      '} catch (e: Exception) {'
    );
    expect(fn).toContain('finally {');
    expect(fn).toContain('settleReplyDelivery(messageId)');
    // Delivered by this drain OR another one: the success action.
    expect(fn).toContain(
      'ownReceivedAt ?: CanariFirebaseMessagingService.replyDeliveredAt(messageId)'
    );
    expect(
      fn.split('replyAnswered(context, groupId, pushCtx, messageId, text, sentAt,').length - 1
    ).toBe(2);
    expect(fn.slice(fn.indexOf('repostReplyPending('))).toContain('?.let { late -> replyAnswered(');
    // The success action is the only place that cancels and announces the read.
    const answered = handle.slice(handle.indexOf('private fun replyAnswered('));
    const body = answered.slice(0, answered.indexOf('private fun sendReadWatermark('));
    // ...through the answer, which keeps ANOTHER reply's line still queued (round-10 review, S2).
    expect(body).toContain(
      'answerReplyNotification(context, groupId, messageId, text, sentAt, receivedAt, notifiedAt, notifiedServerAt)'
    );
    expect(body).not.toContain('cancelConversationNotification(');
    expect(body).toContain('sendReadWatermark(context, groupId, notifiedAt, notifiedServerAt)');
    expect(fn).not.toContain('cancelConversationNotification(');
    expect(fn).not.toContain('sendReadWatermark(');
  });

  // Round-11/12 review (B1, S-a, S-b): Android 15+ drops an app's cancel on a record flagged
  // LIFETIME_EXTENDED_BY_DIRECT_REPLY and strips that flag from an app's post, which lands LATER than
  // a cancel queued behind it. So EVERY cancel of a recorded banner asks the shade first, and a held
  // banner is updated - the standard way, through the one rebuild - and kept, never cancelled.
  it('never app-cancels a banner the platform holds: every path asks the shade first (#3912 F1)', () => {
    const held = source.slice(source.indexOf('private fun holdsDirectReply('));
    const heldBody = held.slice(0, held.indexOf('/**'));
    expect(heldBody).toContain('isHeldByDirectReply(shown)');
    expect(heldBody).not.toContain('.cancel(');
    expect(heldBody).not.toContain('.notify(');
    expect(heldBody).not.toContain('setTimeoutAfter');
    // Every call into the record that may cancel passes the fact and the rebuild.
    const answer = source.slice(source.indexOf('internal fun answerReplyNotification('));
    const call = answer.slice(
      answer.indexOf('READ_ELSEWHERE.answerReply('),
      answer.indexOf('when (outcome)')
    );
    expect(call).toContain('holds = { holdsDirectReply(manager, it) }');
    expect(call).toContain('ownLine = { held -> answerLine(held, replyText, sentAt, receivedAt) }');
    expect(call).toContain('repost = rebuildBanner(context, manager, groupId)');
    expect(call).toContain('watermark,');
    const delivered = source.slice(source.indexOf('private fun replyDelivered('));
    expect(delivered.slice(0, delivered.indexOf('when (outcome)'))).toContain(
      'holds = { holdsDirectReply(manager, it) }'
    );
    const dismiss = source.slice(source.indexOf('internal fun cancelConversationNotification('));
    expect(dismiss).toContain(
      'READ_ELSEWHERE.recordThenCancel(groupId, read, shade, holds, repost, cancelById)'
    );
    expect(dismiss).toContain(
      'READ_ELSEWHERE.withdraw(groupId, keepPendingReply, stableId, shade, holds, repost, cancelById)'
    );
    // The answer is drawn as the user's own line, covered by any read.
    const line = source.slice(source.indexOf('private fun answerLine('));
    expect(line.slice(0, 1500)).toContain('extras.putBoolean(LINE_OWN, true)');
    // The record: a held banner is re-posted and KEPT, never withdrawn, on every path.
    const marks = readFileSync(resolve(dirname(SERVICE), 'push/ReadElsewhereMarks.kt'), 'utf8');
    const helper = marks.slice(marks.indexOf('    private fun cancelUnlessHeldLocked('));
    const helperBody = helper.slice(0, helper.indexOf('    /**'));
    const ask = helperBody.indexOf('if (holds(banner.notifId)) {');
    const ret = helperBody.indexOf('return false', ask);
    const cancel = helperBody.indexOf('cancel(banner.notifId)');
    expect(ask).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(ask);
    expect(cancel).toBeGreaterThan(ret);
    expect(helperBody.slice(ask, ret)).not.toContain('withdrawnLocked(');
    // Each path re-posts what IT leaves on the banner - a delivery never the line it delivered
    // (round-14 review, S-a), a read or a dismissal nothing already read (round-15 review, S2).
    for (const [fn, shown] of [
      ['    fun withdraw(', 'emptyList()'],
      ['    fun recordThenCancel(', 'emptyList()'],
      ['    fun replyDelivered(', 'kept'],
    ]) {
      const at = marks.indexOf(fn);
      expect(at).toBeGreaterThan(-1);
      const body = marks.slice(at, marks.indexOf('    /**', at));
      expect(body).toContain(
        `cancelUnlessHeldLocked(conversationId, banner, ${shown}, holds, repost, cancel)`
      );
      expect(body).not.toContain('withdrawnLocked(');
    }
  });

  // Round-14/15 decisions: a reaction's alert goes WITH the conversation. Its line carries no
  // server instant (LINE_SERVER_AT 0, so no mark can weigh it): the read's OUTCOME decides - only
  // UNREAD keeps it, so a read with no banner removes a lone reaction - and the cancel sits IN the
  // decision's critical section (round 15, S3), so a reaction post cannot fall between them. A
  // source pin: the production shape (serverAt 0) is the JVM suite's fixture.
  it("removes the reaction with the conversation, in the decision's critical section", () => {
    expect(source).not.toContain('rememberReaction');
    expect(source).not.toContain('cancelReactionIfCovered');
    expect(source).not.toContain('forgetReaction');
    const cancel = 'cancelReactionNotification(prefs, manager, groupId)';
    // The answer: the cancel chained on the decision, before the lock closes.
    const answer = source.slice(source.indexOf('internal fun answerReplyNotification('));
    const body = answer.slice(0, answer.indexOf('when (outcome)'));
    const answerLock = body.indexOf('val outcome = synchronized(READ_ELSEWHERE.lock) {');
    const decided = body.indexOf('READ_ELSEWHERE.answerReply(');
    const answerCancel = body.indexOf(`).also { ${cancel} }`);
    expect(answerLock).toBeGreaterThan(-1);
    expect(decided).toBeGreaterThan(answerLock);
    expect(answerCancel).toBeGreaterThan(decided);
    expect(body.slice(answerCancel)).toMatch(/^\)\.also \{[^\n]*\}\n\s*\}\n/);
    // The read: the decision, then on its very next line the cancel unless UNREAD, in the lock.
    const read = source.slice(source.indexOf('internal fun cancelConversationNotification('));
    const fn = read.slice(0, read.indexOf('\n        /**'));
    const lock = fn.indexOf('synchronized(READ_ELSEWHERE.lock) {');
    const outcome = fn.indexOf(
      'val outcome = READ_ELSEWHERE.recordThenCancel(groupId, read, shade, holds, repost, cancelById)'
    );
    const readCancel = fn.indexOf(
      `if (outcome != ReadElsewhereMarks.ReadOutcome.UNREAD) ${cancel}`
    );
    expect(lock).toBeGreaterThan(-1);
    expect(outcome).toBeGreaterThan(lock);
    expect(readCancel).toBeGreaterThan(outcome);
    expect(fn.slice(outcome, readCancel)).toMatch(/^val outcome[^\n]*\n\s*$/);
    // The dismissal: HELD, NONE and CANCELLED each cancel it, inside the same lock.
    // KEPT_PENDING_REPLY too: a send that has not gone out is not an unread message (round 16, S1).
    for (const branch of [
      'ReadElsewhereMarks.Withdrawal.KEPT_PENDING_REPLY -> {',
      'ReadElsewhereMarks.Withdrawal.HELD -> {',
      'ReadElsewhereMarks.Withdrawal.NONE -> {',
    ]) {
      const at = fn.indexOf(branch);
      expect(at).toBeGreaterThan(lock);
      expect(fn.slice(at, fn.indexOf('return', at))).toContain(cancel);
    }
    expect(fn.indexOf(`ReadElsewhereMarks.Withdrawal.CANCELLED -> ${cancel}`)).toBeGreaterThan(
      lock
    );
    // Nothing cancels it after the section: every call sits before what follows the lock.
    expect(fn.lastIndexOf(cancel)).toBeLessThan(fn.indexOf('synchronized(GENERIC_BANNERS_LOCK)'));
    const helper = source.slice(source.indexOf('private fun cancelReactionNotification('));
    const helperBody = helper.slice(0, helper.indexOf('\n        }'));
    expect(helperBody).toContain('manager.cancel(reactionId)');
    expect(helperBody).toContain('READ_ELSEWHERE.reactionWithdrawn(groupId)');
    // A reaction post builds on a fresh base after a withdrawal (round 15, S4).
    expect(source).toContain(
      'READ_ELSEWHERE.reactionBaseOf(groupId) { shadeBannerOf(manager, notifId) }'
    );
    expect(source).toContain('READ_ELSEWHERE.reactionPosted(groupId, notifId)');
  });

  // Round-11 review (S3): a reply not seen delivered is logged at WARN in every case, naming what
  // is known - a failed mirror read told apart by type where it is thrown, not read as empty.
  it('names where an undelivered quick reply stands, never calling an absence a takeover', () => {
    const receiver = readFileSync(
      resolve(dirname(SERVICE), 'CanariNotificationActionReceiver.kt'),
      'utf8'
    );
    const handle = receiver.slice(receiver.indexOf('private fun handleReply('));
    const fn = handle.slice(0, handle.indexOf('private fun replyAnswered('));
    const when = fn.indexOf(
      'when (CanariFirebaseMessagingService.mirrorPresence(context, messageId)) {'
    );
    expect(when).toBeGreaterThan(-1);
    const branches = fn.slice(when, fn.indexOf('repostReplyPending(', when));
    for (const presence of ['QUEUED', 'ABSENT', 'UNREADABLE']) {
      expect(branches).toContain(`MirrorPresence.${presence} ->`);
    }
    expect(branches.split('Log.w(TAG,').length - 1).toBe(3);
    expect(branches).not.toContain('Log.i(');
    expect(branches).toContain('not distinguishable here');
    const presence = source.slice(source.indexOf('internal fun mirrorPresence('));
    expect(presence.slice(0, 400)).toContain(
      'readOutboxMirrorOrNull(context) ?: return@synchronized MirrorPresence.UNREADABLE'
    );
    expect(source).toContain('readOutboxMirrorOrNull(context) ?: emptyList()');
  });

  it('commits the announced-message record and rebuilds the summary after the lock', () => {
    const fn = source.slice(source.indexOf('fun Context.showMessageNotification('));
    const end = fn.indexOf('stamp to alertedKey');
    expect(end).toBeGreaterThan(-1);
    expect(fn.indexOf('postedAlertedKey?.let { rememberAlerted(it) }')).toBeGreaterThan(end);
    expect(fn.indexOf('refreshBadgeSummary(this, justPosted')).toBeGreaterThan(end);
  });
});
