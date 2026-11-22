import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCallAudioConstraints } from '$lib/utils/callAudio';
import { RECORDING_AUDIO_CONSTRAINTS, voiceNoteCapture } from './recordingConstraints';

describe('RECORDING_AUDIO_CONSTRAINTS', () => {
  it('turns the three call-style processings off and asks one channel', () => {
    // Echo cancellation is the one the engines read to choose a call configuration: Chromium's
    // VOICE_COMMUNICATION preset and MODE_IN_COMMUNICATION, WebKit's Voice-Processing I/O unit.
    expect(RECORDING_AUDIO_CONSTRAINTS).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 1 },
    });
  });
});

/**
 * A CALL IS NOT BROKEN BY A NOTE (reading `1.7.3-alpha.6`, voice row 4: it needs a second device
 * holding a call with media, and the web seats have no fake media device). The page's half is the
 * constraints it asks: the call's own while a call is placed or answered, none of the three
 * processings when there is no call. The OS half - the audio mode after the note - is held by
 * `CallSoundHoldTest.kt`; the page never sets a mode.
 */
describe('the constraints a voice note asks, by call phase', () => {
  it("'incall' asks echo cancellation, noise suppression and auto gain, as the call does", () => {
    const { audio, mode } = voiceNoteCapture('incall');
    expect(mode).toBe('call');
    expect(audio).toMatchObject({
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
    });
    expect(audio).toEqual(buildCallAudioConstraints());
  });

  it("'none' asks RECORDING_AUDIO_CONSTRAINTS: all three off, one channel", () => {
    const { audio, mode } = voiceNoteCapture('none');
    expect(mode).toBe('recording');
    expect(audio).toBe(RECORDING_AUDIO_CONSTRAINTS);
    expect(audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 1 },
    });
  });
});

describe('voiceNoteCapture', () => {
  it('is a recording when no call holds the microphone, a ring coming in included', () => {
    for (const phase of ['none', 'incoming'] as const) {
      expect(voiceNoteCapture(phase)).toEqual({
        mode: 'recording',
        audio: RECORDING_AUDIO_CONSTRAINTS,
      });
    }
  });

  it("asks EXACTLY the call's constraints while a call is placed or answered", () => {
    for (const phase of ['calling', 'incall'] as const) {
      expect(voiceNoteCapture(phase)).toEqual({ mode: 'call', audio: buildCallAudioConstraints() });
    }
  });
});

/**
 * The native side sets no call configuration for a recording: the only `MODE_IN_COMMUNICATION`
 * written by Canari's own code is the ongoing-call service's, and no Objective-C sets an
 * `AVAudioSession` category or mode (WebKit owns both). A recording's configuration is therefore
 * decided by its constraints alone, which the tests above pin.
 */
describe('the native call configuration has one owner', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const tauri = resolve(here, '../../../../src-tauri/gen');

  function walk(dir: string, exts: readonly string[]): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === 'build' || name === '.gradle' || name === 'generated') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...walk(full, exts));
      else if (exts.some((e) => name.endsWith(e))) out.push(full);
    }
    return out;
  }

  it('Android: only CallForegroundService.kt sets MODE_IN_COMMUNICATION', () => {
    const root = join(tauri, 'android/app/src/main/java');
    const setters = walk(root, ['.kt', '.java'])
      .filter((f) =>
        /\.mode\s*=\s*AudioManager\.MODE_IN_COMMUNICATION/.test(readFileSync(f, 'utf8'))
      )
      .map((f) => relative(root, f).replaceAll('\\', '/'));
    expect(setters).toEqual(['fr/emse/canari/CallForegroundService.kt']);
  });

  it('iOS: no native code sets an AVAudioSession category or mode', () => {
    const root = join(tauri, 'apple/Sources');
    const setters = walk(root, ['.mm', '.m', '.swift'])
      .filter((f) => /setCategory|setMode\s*:|\.setMode\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f));
    expect(setters).toEqual([]);
  });
});
