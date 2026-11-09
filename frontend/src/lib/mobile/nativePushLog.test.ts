import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { redactLogLine } from '$lib/utils/appLogRedact';
import { NATIVE_PUSH_TAG, formatNativePushLines } from './nativePushLog';

const here = dirname(fileURLToPath(import.meta.url));
const ANDROID = resolve(here, '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari');
const RUST = resolve(here, '../../../src-tauri/src');

describe('formatNativePushLines', () => {
  it('writes nothing when the service logged nothing', () => {
    expect(formatNativePushLines([])).toEqual([]);
  });

  it('tags every line and ends with a per-level summary', () => {
    const out = formatNativePushLines([
      '2026-11-04 10:00:00.000 W CanariFCM: handleChannelMessage: seed absent -> generic banner',
      '2026-11-04 10:00:01.000 E CanariFCM: handleChannelMessage: REFUSED reason=signature-refused',
      '2026-11-04 10:00:02.000 W CanariFCM: openSeedFrame: seed frame refused',
    ]);
    expect(out).toHaveLength(4);
    expect(out.slice(0, 3).every((l) => l.startsWith(`${NATIVE_PUSH_TAG} 2026-11-04`))).toBe(true);
    expect(out[3]).toContain('3 push-service line(s)');
    expect(out[3]).toContain('errors=1 warnings=2');
  });

  it('leaves the device under the in-app log rules: a carried line is redacted like any other', () => {
    const [line] = formatNativePushLines([
      '2026-11-04 10:00:00.000 W CanariFCM: reportBlindBanner: exception: Bearer abcdefghijklmnop',
    ]);
    expect(redactLogLine(line).line).not.toContain('abcdefghijklmnop');
  });
});

describe('the service, the bridge and the page agree', () => {
  it('the service logs through FcmLog, so every WARN and ERROR line reaches the file', () => {
    const service = readFileSync(resolve(ANDROID, 'CanariFirebaseMessagingService.kt'), 'utf8');
    expect(service).toContain('import fr.emse.canari.FcmLog as Log');
    expect(service).not.toMatch(/^import android\.util\.Log$/m);
  });

  it('names one JNI symbol on both sides and registers the command the page invokes', () => {
    const kotlin = readFileSync(resolve(ANDROID, 'NativePushLog.kt'), 'utf8');
    const lib = readFileSync(resolve(RUST, 'lib.rs'), 'utf8');
    expect(kotlin).toContain('object NativePushLog');
    expect(kotlin).toContain('external fun nativeAppendPushLog(');
    expect(lib).toContain('fn Java_fr_emse_canari_NativePushLog_nativeAppendPushLog');
    expect(lib).toMatch(/\n\s+take_native_push_log,\n/);
  });
});
