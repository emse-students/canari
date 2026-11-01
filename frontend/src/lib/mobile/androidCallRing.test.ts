import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE ANDROID IN-APP RING RINGS ONCE, AND ONLY ON SCREEN (owner, 2026-11-01; review of #2877).
 *
 * `CallRingPlayer.kt` drives a `MediaPlayer`, an `AudioManager` and a `Vibrator`: the plain-JVM
 * `android-tests` project cannot run it, and its pure rules are `IncomingRingTest.kt`. What is held
 * here, at source level, is the wiring those rules do not see - each line below is a defect the
 * review found or one that would bring it back:
 * - the player refuses a start off screen and posts the native ring instead (two rings, or a ring
 *   that outlives its screen, otherwise);
 * - leaving the screen hands the call to the native CallStyle ring (a Home press left it silent);
 * - every end of the native ring stops the player of that call, and the page's stop ends both;
 * - the ring takes transient audio focus and gives it back;
 * - `canari_calls_v2` inherits what the user set on `canari_calls`, read before it is deleted.
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
const application = read('CanariApplication.kt');

/** The body of `fun <name>(`, up to the closing brace at the indentation of its declaration. */
function body(source: string, name: string): string {
  const start = source.indexOf(`fun ${name}(`);
  expect(start, `fun ${name} introuvable`).toBeGreaterThan(-1);
  const lineStart = source.lastIndexOf('\n', start) + 1;
  const indent = /^ */.exec(source.slice(lineStart))?.[0] ?? '';
  const end = source.indexOf(`\n${indent}}`, start);
  expect(end, `fin de ${name} introuvable`).toBeGreaterThan(-1);
  return source.slice(start, end);
}

describe('the Android in-app ring (CallRingPlayer)', () => {
  it('refuses a start off screen, as its FIRST check, and posts the native ring instead', () => {
    const start = body(player, 'start');
    const guard = start.indexOf('if (!MainActivity.isInForeground) {');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(start.indexOf('ringingCallId == r.callId'));
    expect(start).toContain('start REFUSED');
    expect(start.slice(guard)).toMatch(/postNativeRing\(context, r, /);
  });

  it('cancels a native ring of the same call before it plays, so the call rings once', () => {
    const start = body(player, 'start');
    expect(start.indexOf('cancelIncomingCallNotification(context, r.callId)')).toBeLessThan(
      start.indexOf('play(context, audio)')
    );
  });

  it('leaving the screen hands the call to the native CallStyle ring', () => {
    const onStop = activity.match(/override fun onStop\(\) \{[\s\S]*?\n {4}\}/)?.[0] ?? '';
    expect(onStop).toContain('CallRingPlayer.handOverOffScreen(this)');
    const handOver = body(player, 'handOverOffScreen');
    expect(handOver).toContain('stopLocked(');
    expect(handOver).toContain('postNativeRing(context, r, ');
    expect(body(player, 'postNativeRing')).toContain(
      'CanariFirebaseMessagingService.showIncomingCallNotification('
    );
  });

  it('the page hands over every fact the native ring posts', () => {
    const ringStart = body(bridge, 'ringStart');
    for (const field of ['callId', 'groupId', 'callerId', 'hasVideo', 'appSounds']) {
      expect(ringStart).toContain(`"${field}"`);
    }
  });

  it('every end of the native ring stops the player of that call; the page stop ends both', () => {
    expect(body(fcm, 'cancelIncomingCallNotification')).toContain(
      'CallRingPlayer.stopIfRinging(context, callId, '
    );
    // `call_ring_end` ends the ring through that one function.
    expect(fcm).toMatch(
      /msgType == "call_ring_end"\) \{[\s\S]*?cancelIncomingCallNotification\(this, /
    );
    const ringStop = body(bridge, 'ringStop');
    expect(ringStop).toContain('CallRingPlayer.stopIfRinging(context, callId, why)');
    expect(ringStop).toContain(
      'CanariFirebaseMessagingService.cancelIncomingCallNotification(context, callId)'
    );
  });

  it('takes transient audio focus with the ringtone attributes, and abandons it on stop', () => {
    expect(body(player, 'play')).toContain(
      'AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)'
    );
    expect(body(player, 'play')).toContain('.setAudioAttributes(ringAttributes)');
    expect(body(player, 'stopLocked')).toContain('abandonAudioFocusRequest(');
    // Another call in progress only vibrates.
    expect(body(player, 'start')).toContain(
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

  it('logs importance, bypass and vibration, and owes the user a Do Not Disturb ask', () => {
    const read = body(application, 'supersededCallsChannel');
    expect(read).toContain('canBypassDnd()');
    expect(read).toContain('shouldVibrate()');
    expect(read).toContain('putBoolean(KEY_DND_REGRANT_OWED, true)');
  });
});
