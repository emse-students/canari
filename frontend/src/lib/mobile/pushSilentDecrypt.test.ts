import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A SILENT PUSH IS NOT DECRYPTED, AND THE TWO SWITCHES THAT DECIDE THAT MUST AGREE.
 *
 * ## What a silent frame can produce, which is nothing
 *
 * Every message to an Android device arrives as TWO pushes: the visible one, and the other device
 * of the same account sending its read watermark. The second is `silent=true`, and a silent
 * `type=message` frame cannot produce anything:
 *
 * - no notification, by definition - `silent` is exactly the instruction not to show one;
 * - no `mls.bin` write - `mobile/background.rs` states in its own header that the read-only push
 *   paths never persist state, and `decryptProto` discards commits;
 * - no FCM cache entry - the silent return happens before `writeFcmCache`.
 *
 * **The one and only consumer of a silent frame's plaintext is call signalling** (`call_invite`
 * rings, `call_control` stops a ring), and the whole calling surface is held off. So the decrypt is
 * skipped rather than paid for.
 *
 * ## What paying for it cost, which is why this test exists
 *
 * Measured on a Mi 9T with an 8 MB store, 2026-09-07: each frame is ~10.7 seconds of Argon2 and an
 * 8 MB read, serialised on the ONE push lane every other message queues behind. NOTIF-11 sent three
 * messages six seconds apart and the third notified 127 seconds after the first - seven seconds
 * after the row's window had closed. Half of that lane was frames that could not produce anything.
 *
 * ## Why this is a test and not a comment
 *
 * The skip is gated on the Kotlin `CALLS_ENABLED`, which DUPLICATES the TypeScript one: the service
 * handles pushes while no webview exists, so it cannot read the app's constant. A duplicated switch
 * is a switch that gets flipped on one side - and flipping only the TypeScript one would leave a
 * ringing app whose silent call frames are never decrypted, which is a silent half-revival rather
 * than a build error.
 *
 * It reads text, so it proves the guard is written and not that it is reached. What it catches is
 * the change that actually happens: the calls revival touching `features.ts` and stopping there.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SERVICE = resolve(
  here,
  '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt'
);
const FEATURES = resolve(here, '../features.ts');

const service = () => readFileSync(SERVICE, 'utf8');

/** `CALLS_ENABLED` as each side spells it, or null when the declaration is gone. */
function callsEnabledIn(src: string, pattern: RegExp): boolean | null {
  const m = src.match(pattern);
  return m ? m[1] === 'true' : null;
}

describe('a silent push is not decrypted while nothing reads its plaintext', () => {
  it('the two CALLS_ENABLED switches agree', () => {
    const kotlin = callsEnabledIn(service(), /private const val CALLS_ENABLED = (true|false)/);
    const ts = callsEnabledIn(
      readFileSync(FEATURES, 'utf8'),
      /export const CALLS_ENABLED = (true|false)/
    );
    expect(kotlin, 'the Kotlin CALLS_ENABLED was renamed or removed').not.toBeNull();
    expect(ts, 'the TypeScript CALLS_ENABLED was renamed or removed').not.toBeNull();
    expect(
      kotlin,
      'CALLS_ENABLED differs between the app and the push service. The service cannot read the ' +
        'webview constant - it runs when no webview exists - so the two are duplicated and must be ' +
        'flipped in the same commit. See the constant in CanariFirebaseMessagingService.kt.'
    ).toBe(ts);
  });

  it('exactly one Kotlin declaration of it', () => {
    // It already existed for the ring; a second one was added by hand on 2026-09-07 and Kotlin
    // would have refused the file. Cheaper to say so here than to find out in a six-minute build.
    expect(service().split('private const val CALLS_ENABLED').length - 1).toBe(1);
  });

  it('the silent frame is skipped, and on the switch rather than on a message shape', () => {
    const src = service();
    expect(
      src,
      'the guard that skips a silent push has gone. Without it every message on this device is ' +
        'decrypted twice, and the second decrypt can produce nothing - 10.7 s of Argon2 and an ' +
        '8 MB read on the lane the NEXT message is queued behind.'
    ).toContain('if (silent && !CALLS_ENABLED)');
  });

  it('and it is decided BEFORE the decrypt, not after it', () => {
    const src = service();
    const guard = src.indexOf('if (silent && !CALLS_ENABLED)');
    const decrypt = src.indexOf('var outcome = tryDecrypt(');
    expect(guard).toBeGreaterThan(-1);
    expect(decrypt).toBeGreaterThan(-1);
    expect(
      guard,
      'the skip sits after the decrypt, so it saves nothing at all - the cost this exists to avoid ' +
        'is the decrypt itself, not what is done with its result.'
    ).toBeLessThan(decrypt);
  });
});
