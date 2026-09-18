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
    const notify = source.indexOf('manager.notify(notifId, notif)\n\n            // WRITTEN AFTER');
    expect(notify).toBeGreaterThan(-1);
    expect(source.slice(notify, notify + 400)).toContain('rememberAlerted(it)');
  });
});
