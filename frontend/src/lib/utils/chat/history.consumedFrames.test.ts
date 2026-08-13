/**
 * The mark that stops a device reporting its own traffic as lost.
 *
 * A frame delivered live, or drained from the server queue, is decrypted OUTSIDE the archive replay
 * and so leaves this device's position in the archive behind it. The replay later walks that same
 * row, finds the generation already spent, and reports real loss for a message the device is
 * displaying. These cases pin the two halves that make the repair work: the two paths agree on a
 * key, and a mark made during a replay is not erased by that replay's final write.
 */
import { frameFingerprint } from '$lib/mls-client/inboundFrameLedger';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import { markHistoryFrameConsumed, resetSeenCipherCacheForTests } from './history';

const USER = 'user-1';
const GROUP = 'group-1';
const KEY = `history_seen_cipher:${USER}:${GROUP}`;

/** Reads the persisted set the way a later page load would. */
const persisted = (): string[] => JSON.parse(localStorage.getItem(KEY) ?? '[]');

/** Lets the coalesced flush run. A microtask drain, never a wall clock. */
const flush = () => Promise.resolve().then(() => undefined);

beforeEach(() => {
  localStorage.clear();
  resetSeenCipherCacheForTests();
});

describe('the key the two delivery paths share', () => {
  it('is identical whether the frame came off the archive or off the wire', () => {
    // The server writes ONE string: the same `proto` goes into the Redis stream and into the live
    // envelope, with no re-encoding between them. So the archive's base64 `content`, decoded, is
    // byte-for-byte the live frame's ciphertext - which is why a fingerprint over the bytes is a
    // usable shared key while the two ids (stream id vs queued-message uuid) never intersect.
    const wire = new Uint8Array([0x20, 0x0b, 0xad, 0xf0, 0x0d, 0x00, 0xff, 0x7f]);
    const fromArchive = fromBase64(toBase64(wire));

    expect(frameFingerprint(fromArchive)).toBe(frameFingerprint(wire));
  });

  it('separates frames that differ by a single byte', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);

    expect(frameFingerprint(a)).not.toBe(frameFingerprint(b));
  });
});

describe('markHistoryFrameConsumed', () => {
  it('persists the mark under the group key, so a reload skips the row instead of failing on it', async () => {
    markHistoryFrameConsumed(USER, GROUP, 'fp-a');
    await flush();

    expect(persisted()).toEqual(['fp-a']);
  });

  it('keeps what was already there rather than replacing it', async () => {
    localStorage.setItem(KEY, JSON.stringify(['older-stream-id']));

    markHistoryFrameConsumed(USER, GROUP, 'fp-a');
    await flush();

    expect(persisted()).toEqual(['older-stream-id', 'fp-a']);
  });

  it('collapses a whole drain into ONE write', async () => {
    // A reconnect hands over a burst of frames in one turn. Each mark rewriting a set capped at
    // five thousand entries would put a `JSON.stringify` of the lot on the hot inbound path.
    // On the INSTANCE, not on `Storage.prototype`: under jsdom the prototype spy never fires, which
    // would have made every count below trivially zero - and the "does not write twice" case would
    // have passed while measuring nothing at all.
    const setItem = vi.spyOn(localStorage, 'setItem');

    for (let i = 0; i < 40; i++) markHistoryFrameConsumed(USER, GROUP, `fp-${i}`);
    await flush();

    expect(setItem.mock.calls.filter(([k]) => k === KEY)).toHaveLength(1);
    expect(persisted()).toHaveLength(40);
    setItem.mockRestore();
  });

  it('does not write twice for the same frame', async () => {
    markHistoryFrameConsumed(USER, GROUP, 'fp-a');
    await flush();
    // Installed AFTER the first mark is persisted, so what it counts is the second mark alone.
    const setItem = vi.spyOn(localStorage, 'setItem');

    markHistoryFrameConsumed(USER, GROUP, 'fp-a');
    await flush();

    expect(setItem.mock.calls.filter(([k]) => k === KEY)).toHaveLength(0);
    setItem.mockRestore();
  });

  it('is a no-op without an identified user or group, rather than writing a nameless key', async () => {
    markHistoryFrameConsumed('', GROUP, 'fp-a');
    markHistoryFrameConsumed(USER, '', 'fp-a');
    await flush();

    expect(localStorage.length).toBe(0);
  });

  it('keeps each group to its own set', async () => {
    markHistoryFrameConsumed(USER, GROUP, 'fp-a');
    markHistoryFrameConsumed(USER, 'group-2', 'fp-b');
    await flush();

    expect(persisted()).toEqual(['fp-a']);
    expect(JSON.parse(localStorage.getItem(`history_seen_cipher:${USER}:group-2`) ?? '[]')).toEqual(
      ['fp-b']
    );
  });
});

describe('a mark made while a replay is walking', () => {
  it('survives the replay writing its own copy back at the end', async () => {
    // THE REASON THE SET IS SHARED RATHER THAN RE-READ. The replay loads the set when it starts,
    // mutates it for the whole walk, and writes it back once at the end. If live delivery marked a
    // frame into a DIFFERENT object in between, that final write - made from a copy taken before
    // the mark existed - would erase it, and the false loss would return at the next reload.
    //
    // Simulated here from the outside: a first mark stands in for the replay's hydration, a second
    // for a live frame arriving mid-walk, and the assertion is that the durable set holds both.
    localStorage.setItem(KEY, JSON.stringify(['stream-id-1']));
    markHistoryFrameConsumed(USER, GROUP, 'stream-id-1'); // hydrates the shared set, adds nothing
    markHistoryFrameConsumed(USER, GROUP, 'fp-live');
    await flush();

    expect(persisted()).toEqual(['stream-id-1', 'fp-live']);
  });
});
