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
    const before = source.slice(record - 1600, record);
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
    expect(builder.slice(step)).toContain(
      'READ_ELSEWHERE.postUnlessRead(groupId, sentAt, serverAt, linesOf(style), postToShade)'
    );
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

  it('looks the notification up inside recordThenCancel, never before it', () => {
    const fn = source.slice(source.indexOf('internal fun cancelConversationNotification('));
    const guarded = fn.indexOf('READ_ELSEWHERE.recordThenCancel(');
    expect(guarded).toBeGreaterThan(-1);
    const lambda = fn.slice(guarded, fn.indexOf('cancel = {', guarded));
    expect(lambda).toContain('notifId = prefs.getInt(groupId, -1)');
    expect(lambda).toContain('shadeLinesOf(manager, notifId)');
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
  it('hands the posted lines to the record with the post', () => {
    expect(source).toContain('linesOf(style), postToShade)');
  });

  it('restamps a re-injected line when the second trigger knows the server instant', () => {
    const fn = source.slice(source.indexOf('fun Context.showMessageNotification('));
    const restamp = fn.indexOf('THE SECOND TRIGGER MAY KNOW MORE');
    expect(restamp).toBeGreaterThan(-1);
    expect(fn.slice(restamp, restamp + 900)).toContain(
      'it.extras.putLong(LINE_SERVER_AT, serverAt)'
    );
  });

  it('forgets the record when the banner is removed another way', () => {
    const fn = source.slice(source.indexOf('internal fun cancelConversationNotification('));
    expect(fn.slice(0, fn.indexOf('READ_ELSEWHERE.recordThenCancel('))).toContain(
      'READ_ELSEWHERE.forget(groupId)'
    );
  });
});
