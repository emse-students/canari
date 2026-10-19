import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A SILENT PUSH IS NOT DECRYPTED, WHETHER OR NOT CALLS ARE ON.
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
 * One thing reads a silent frame's plaintext: **Graine key material**, the exception this guard
 * carries. A seed minted while the app was shut arrives silent and nowhere else, and dropping it
 * left every message of that session showing the generic salon body until the app was next opened.
 * **Call signalling is NOT one of them**: a ring reaches a shut phone as the cleartext `call_ring`
 * push, sent and awaited BEFORE the MLS invite leaves, and stops with `call_ring_end`.
 *
 * **THE EXCEPTION IS NAMED BY THE SERVER, NOT DISCOVERED BY DECRYPTING.** `isKeyDistribution` is a
 * cleartext field saying the conversation is a key-distribution group, read from the `dm_groups`
 * columns the push already fetched the row for. Deciding it here rather than after the decrypt is
 * the whole point: the cost below is the decrypt itself. See
 * `docs/wiki/protocols/channel-encryption.md` section 14.
 *
 * So the decrypt is skipped rather than paid for, everywhere except the one frame that has
 * something in it.
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
 * Until 2026-10-18 the skip held only while the Kotlin calls switch was off, so the calls revival - flipping the
 * Kotlin switch with the four others - would have restored the decrypt above behind every read
 * receipt, to find the rare silent `call_invite` among them, which nothing needs since the cleartext
 * ring. The guard no longer names the switch, and this test fails if it ever does again.
 *
 * It reads text, so it proves the guard is written and not that it is reached.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SERVICE = resolve(
  here,
  '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt'
);

const service = () => readFileSync(SERVICE, 'utf8');

describe('a silent push is not decrypted while nothing reads its plaintext', () => {
  it('the silent frame is skipped, and NOT on the calls switch', () => {
    const src = service();
    expect(
      src,
      'the guard that skips a silent push has gone. Without it every message on this device is ' +
        'decrypted twice, and the second decrypt can produce nothing - 10.7 s of Argon2 and an ' +
        '8 MB read on the lane the NEXT message is queued behind.'
    ).toContain('if (silent && isKeyDistribution != true)');
    expect(
      src,
      'the silent guard reads the calls switch again, so turning calls on decrypts every read ' +
        'receipt. A ring is the cleartext call_ring push; it needs no silent decrypt.'
    ).not.toMatch(/silent && !?CALLS_ENABLED/);
  });

  it('the ONE exception is the frame the server named, not a shape found by decrypting', () => {
    const src = service();
    expect(
      src,
      'the key-material exception has gone or is no longer decided on the cleartext field. ' +
        'Reading a silent frame to find out what is in it puts an MLS load and the state lock ' +
        'behind every read receipt, for frames with nothing in them.'
    ).toContain('if (silent && isKeyDistribution != true)');
    // `!= true`, never `== false`: an absent key says the server did not know, which is a
    // different sentence from "no" - and the old behaviour is what an unknown keeps.
    expect(src).not.toMatch(/isKeyDistribution == false/);
  });

  it('and it is decided BEFORE the decrypt, not after it', () => {
    const src = service();
    const guard = src.indexOf('if (silent && isKeyDistribution != true)');
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
