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
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import {
  hasHistoryFrameBeenConsumed,
  markHistoryFrameConsumed,
  replayConversationHistory,
  resetSeenCipherCacheForTests,
} from './history';

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

/**
 * THE LEDGER IN THE OTHER DIRECTION - the replay telling live delivery what IT has consumed.
 *
 * WP-FALSELOSS-1 made live delivery visible to the replay and stopped there, so the seam stayed
 * one-way: a frame the replay had just decrypted arrived live a moment later, `handleUnreadableFrame`
 * had nowhere to look it up, and a message already on screen was reported LOST and reconciled for.
 * Measured on prod 2026-08-13 (WP-FALSELOSS-2) - three MSG checks dirty, with `copiesOnReceiver: 1`
 * recorded inside the very run reporting the loss, which is what proved nothing had been lost.
 *
 * The row id the replay writes cannot serve: a live envelope is addressed by a `queued_message`
 * uuid and an archive row by a Redis stream id, and the server discards the stream id at write time.
 * Only the bytes are shared.
 */
describe('a frame the archive replay consumed', () => {
  const wire = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]);
  const row = {
    id: '1786655250946-0',
    sender_id: 'peer',
    content: toBase64(wire),
    timestamp: String(1786655250946),
  };

  /** Drives one replay page and returns the commit thunk. One result per row, in order. */
  const replayPage = async (
    rows: Array<{ id: string; sender_id: string; content: string; timestamp: string }>,
    results: Array<{ ok: boolean; plaintext?: null; error?: string }>
  ) => {
    const mlsService = createMlsServiceStub({
      getLocalGroups: vi.fn().mockReturnValue([GROUP]),
      createDecryptSession: vi.fn().mockResolvedValue({
        decryptPage: vi.fn().mockResolvedValue(results),
        finish: vi.fn().mockResolvedValue(undefined),
      }),
      // The page after the primed one is empty, which is what ends the walk.
      fetchHistory: vi.fn().mockResolvedValue([]),
    });
    return replayConversationHistory({
      mlsService,
      id: GROUP,
      contactName: 'peer',
      userId: USER,
      deviceKeyB64: 'device-key',
      storage: null,
      getConversation: () => undefined,
      setConversation: () => undefined,
      messageReactions: new Map(),
      log: () => undefined,
      primedFirstPage: rows,
    });
  };

  /** The single-frame case, which is what most of these assertions need. */
  const replayOnePage = (result: { ok: boolean; plaintext?: null; error?: string }) =>
    replayPage([row], [result]);

  it('is recognised by live delivery, so the same frame arriving on the wire is a duplicate and not a loss', async () => {
    // `plaintext: null` is a frame with no application payload - a commit. It consumes its ratchet
    // generation exactly like a message does, which is the whole reason the mark is taken before
    // anything looks at the payload.
    await replayOnePage({ ok: true, plaintext: null });

    expect(hasHistoryFrameBeenConsumed(USER, GROUP, frameFingerprint(wire))).toBe(true);
  });

  it('survives the reload, because the durable set is what live delivery reads', async () => {
    const commit = await replayOnePage({ ok: true, plaintext: null });
    // The replay does not persist its own progress: the caller commits it once the encrypted MLS
    // checkpoint has flushed, so durable progress can never run ahead of the durable ratchet.
    commit?.();
    await flush();

    expect(persisted()).toContain(frameFingerprint(wire));
  });

  it('is NOT claimed when the frame failed to decrypt - nobody has read it, and saying otherwise silences a real loss', async () => {
    // The safety property of the whole change. A frame that did not decrypt consumed nothing, so
    // marking its bytes would tell live delivery "already read" about a frame no one has ever read -
    // and the LOST-frame signal, which is the only thing that raises a repair, would go quiet on the
    // one case it exists for. The row is still marked seen, so the replay does not walk it forever.
    await replayOnePage({
      ok: false,
      error: 'ValidationError(UnableToDecrypt(SecretTreeError(SecretReuseError)))',
    });

    expect(hasHistoryFrameBeenConsumed(USER, GROUP, frameFingerprint(wire))).toBe(false);
    expect(hasHistoryFrameBeenConsumed(USER, GROUP, row.id)).toBe(true);
  });

  /**
   * THE WHOLE PAGE IS MARKED WHEN THE PAGE IS DECRYPTED, NOT AS EACH FRAME IS PROCESSED.
   *
   * `decryptPage` spends the ratchet for every row it is given, in one call. The marks used to be
   * written by the loop that processes those rows afterwards - decoding, adding to the chat,
   * awaiting - so between the two there was a window in which a generation was gone and the ledger
   * did not say so. A frame arriving live inside that window looked itself up, found nothing, and was
   * reported LOST: measured on prod 2026-08-14 as an exactly reproducible pair, generation 520 called
   * a loss and generation 521 of the SAME page recognised as a duplicate three seconds later.
   */
  describe('a page of several frames', () => {
    const second = new Uint8Array([0x99, 0x88, 0x77]);
    const secondRow = {
      id: '1786655250946-1',
      sender_id: 'peer',
      content: toBase64(second),
      timestamp: String(1786655250947),
    };

    it('marks every frame the batch decrypted, not only the ones already processed', async () => {
      await replayPage(
        [row, secondRow],
        [
          { ok: true, plaintext: null },
          { ok: true, plaintext: null },
        ]
      );

      expect(hasHistoryFrameBeenConsumed(USER, GROUP, frameFingerprint(wire))).toBe(true);
      expect(hasHistoryFrameBeenConsumed(USER, GROUP, frameFingerprint(second))).toBe(true);
    });

    it('still claims only what decrypted, when one frame of the page failed', async () => {
      await replayPage(
        [row, secondRow],
        [
          { ok: true, plaintext: null },
          {
            ok: false,
            error: 'ValidationError(UnableToDecrypt(SecretTreeError(SecretReuseError)))',
          },
        ]
      );

      expect(hasHistoryFrameBeenConsumed(USER, GROUP, frameFingerprint(wire))).toBe(true);
      expect(hasHistoryFrameBeenConsumed(USER, GROUP, frameFingerprint(second))).toBe(false);
    });
  });
});

describe('hasHistoryFrameBeenConsumed', () => {
  it('answers no for a frame nothing has marked, so an unread frame still reconciles', () => {
    expect(hasHistoryFrameBeenConsumed(USER, GROUP, 'never-seen')).toBe(false);
  });

  it('reads what an earlier SESSION wrote - the in-memory ring cannot, and that is why it exists', () => {
    localStorage.setItem(KEY, JSON.stringify(['fp-from-a-previous-page-load']));

    expect(hasHistoryFrameBeenConsumed(USER, GROUP, 'fp-from-a-previous-page-load')).toBe(true);
  });

  it('is a no-op without an identified user or group rather than reading a nameless key', () => {
    expect(hasHistoryFrameBeenConsumed('', GROUP, 'fp-a')).toBe(false);
    expect(hasHistoryFrameBeenConsumed(USER, '', 'fp-a')).toBe(false);
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
