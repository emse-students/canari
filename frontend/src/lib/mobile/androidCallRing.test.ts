import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE ANDROID RING'S WIRING (owner, 2026-11-01; reviews of #2877).
 *
 * The SEQUENCING - one ring per call, the foreground guard, the hand-over, a closed call never
 * ringing again, the second call releasing the first's audio focus - is `RingSequencer`, run on the
 * plain JVM by `android-tests/.../RingSequencerTest.kt`. What is held here is only what that test
 * cannot see: that the Android callers reach the sequencer at all, each with the fact it owns.
 */
const MAIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari'
);
const read = (name: string) => readFileSync(resolve(MAIN, name), 'utf8');
const player = read('CallRingPlayer.kt');
const activity = read('MainActivity.kt');
const fcm = read('CanariFirebaseMessagingService.kt');
const bridge = read('CallBridge.kt');
const answer = read('CallRingAnswer.kt');
const application = read('CanariApplication.kt');

/** The body of `fun <name>(`, up to the closing brace at the indentation of its declaration. */
function body(source: string, name: string): string {
  const start = source.indexOf(`fun ${name}(`);
  expect(start, `fun ${name} not found`).toBeGreaterThan(-1);
  const lineStart = source.lastIndexOf('\n', start) + 1;
  const indent = /^ */.exec(source.slice(lineStart))?.[0] ?? '';
  const end = source.indexOf(`\n${indent}}`, start);
  expect(end, `end of ${name} not found`).toBeGreaterThan(-1);
  return source.slice(start, end);
}

describe('the Android ring reaches its one sequencer', () => {
  it('the screen the sequencer asks is the activity in front', () => {
    expect(player).toContain('RingSequencer({ MainActivity.isInForeground }, output)');
  });

  it('leaving the screen tells it whether the SCREEN went off (the power button)', () => {
    const onStop = activity.match(/override fun onStop\(\) \{[\s\S]*?\n {4}\}/)?.[0] ?? '';
    expect(onStop).toContain('PowerManager).isInteractive');
    expect(onStop).toContain('CallRingPlayer.leftScreen(screenOff)');
  });

  it('the native ring is posted from a worker, never the main thread', () => {
    expect(body(player, 'postNative')).toContain('Thread(');
  });

  it('the native post and its claim are one critical section', () => {
    const show = body(fcm, 'showIncomingCallNotification');
    const claim = show.indexOf('CallRingPlayer.rings.claimNative(callId) {');
    expect(claim).toBeGreaterThan(-1);
    expect(show.indexOf('manager.notify(notifId, notif)')).toBeGreaterThan(claim);
  });

  it('an answer on the native ring closes the call', () => {
    expect(body(answer, 'takeAnswer')).toContain(
      'CallRingPlayer.rings.close(callId, RingClosed.ANSWERED, '
    );
  });

  it('every end of the call closes it, the page stop included', () => {
    expect(body(fcm, 'cancelIncomingCallNotification')).toContain(
      'CallRingPlayer.rings.close(callId, RingClosed.ENDED, reason)'
    );
    expect(fcm).toMatch(
      /msgType == "call_ring_end"\) \{[\s\S]*?cancelIncomingCallNotification\(this, /
    );
    expect(body(bridge, 'ringStop')).toContain('cancelIncomingCallNotification(context, callId, ');
  });

  it('the page hands over every fact the native ring posts', () => {
    const ringStart = body(bridge, 'ringStart');
    for (const field of ['callId', 'groupId', 'callerId', 'hasVideo', 'appSounds']) {
      expect(ringStart).toContain(`"${field}"`);
    }
  });

  it('the ring takes transient audio focus with the ringtone attributes', () => {
    expect(body(player, 'startPlayer')).toContain(
      'AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)'
    );
    expect(body(player, 'silenceRing')).toContain('abandonAudioFocusRequest(');
    expect(body(player, 'playRing')).toContain(
      'inAnotherCall = audioMode != AudioManager.MODE_NORMAL'
    );
  });
});

describe('canari_calls_v2 inherits canari_calls', () => {
  it('reads the old channel BEFORE deleting it, and creates v2 with its importance', () => {
    const ensure = body(application, 'ensureChannels');
    expect(ensure.indexOf('supersededCallsChannel(context, manager)')).toBeLessThan(
      ensure.indexOf('deleteSupersededChannels(manager)')
    );
    expect(ensure).toContain('IncomingRing.inheritedImportance(oldCalls?.importance)');
  });

  it('keeps a sound set to None silent, and carries the lock-screen visibility and the badge', () => {
    const ensure = body(application, 'ensureChannels');
    expect(ensure).toContain('if (oldCalls?.silent == true) setSound(null, null)');
    expect(ensure).toContain('lockscreenVisibility = it.lockscreenVisibility');
    expect(ensure).toContain('setShowBadge(it.showBadge)');
  });

  it('logs what it read, and owes the user a Do Not Disturb ask until it is answered', () => {
    const old = body(application, 'supersededCallsChannel');
    expect(old).toContain('canBypassDnd()');
    expect(old).toContain('shouldVibrate()');
    expect(old).toContain('putBoolean(KEY_DND_REGRANT_OWED, true)');
    expect(body(application, 'isDndRegrantOwed')).not.toContain('remove(');
    expect(body(application, 'dndRegrantAnswered')).toContain('remove(KEY_DND_REGRANT_OWED)');
  });
});
