import type { IStorage, StoredGraineSession } from '$lib/db/types';
import { byNewestSession } from '$lib/db/graineCodec';
import {
  GraineSignatureBatchError,
  GraineSignatureError,
  encodeGraineEndorsementV2,
  graineSeedCommitment,
  openWithGraineV2,
  sealWithGraineV2,
} from '$lib/crypto/graineV2';
import { ed25519PublicKeyOf, webCryptoEngine } from '$lib/crypto/graineV2.testEngine';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import {
  GraineAuthorMismatchError,
  GraineBelowFirstIndexError,
  GraineChannelMismatchError,
  GraineReplayError,
  GraineSessionUnavailableError,
  GraineUnknownChannelError,
  GraineV1SessionNotHeldError,
  GRAINE_SIGNATURE_BATCH_MAX,
  openChannelMessage,
  openChannelMessagePage,
  sealChannelMessage,
  type OpenableChannelMessage,
} from './channelSeal';
import { deriveMessageKeyBytes } from '$lib/crypto/graine';
import { GraineDistributionUnavailableError } from './seedDistribution';
import { registerChannelWorkspace, setGraineRuntime } from './runtime';
import type { DistributionScope } from '$lib/mls-client/distributionScope';

/**
 * The seam that replaced the server-derived epoch key (WP-31/32).
 *
 * What is pinned: a message is sealed under a session the community can actually READ (the seal is
 * refused otherwise, rather than producing a row nobody can open), the round trip really works
 * against the pure crypto rather than against a stub of itself, and every unreadability is a TYPE -
 * because a missing seed is repairable, a message below the handover floor is the protocol working,
 * and rendering both as "no message" is the silence this whole rework exists to remove.
 */

vi.mock('./graineMirror', () => ({ mirrorGraineSeed: vi.fn().mockResolvedValue(undefined) }));

const WS = 'ws-1';
const CHANNEL = 'chan-1';

function fakeStorage(seed: StoredGraineSession[] = []) {
  const rows = new Map(seed.map((s) => [s.sessionId, s]));
  return {
    rows,
    storage: {
      getGraineSessions: async (channelId: string) =>
        [...rows.values()].filter((s) => s.channelId === channelId).sort(byNewestSession),
      getGraineSession: async (sessionId: string) => rows.get(sessionId) ?? null,
      saveGraineSession: async (s: StoredGraineSession) => {
        rows.set(s.sessionId, s);
      },
    } as unknown as IStorage,
  };
}

/**
 * An MLS service holding the distribution groups at `epoch`, or holding none.
 *
 * BOTH SCOPES, because the salon's group is the whole point: a stub that only answered for the
 * community would let a seal meant for a private salon fall back to the community's group and the
 * test would still pass, which is exactly the defect.
 */
/** The stand-in for this device's MLS credential key. */
const DEVICE_SECRET = new Uint8Array(32).fill(3);

function fakeMls(epoch: number | null) {
  const sent: { groupId: string; bytes: Uint8Array }[] = [];
  return {
    sent,
    mls: {
      distributionGroupFor: (scope: DistributionScope) => {
        if (scope.kind === 'workspace') return scope.workspaceId === WS ? 'g-1' : null;
        return scope.channelId === CHANNEL ? 'g-salon' : null;
      },
      getLocalGroups: () => (epoch === null ? [] : ['g-1', 'g-salon']),
      // Settled unless a test says otherwise: the unsettled state lasts only for the create
      // window of `ensureDistributionGroup`, and every seal below happens long after one.
      isDistributionBaseSettled: () => true,
      getEpoch: () => epoch ?? 0,
      // One clean run per group, never moving: the rotation rule itself is pinned in
      // `sessionManager.test.ts` and in `mls-core/tests/graine_run.rs`.
      graineRun: async (groupId: string) => ({
        runId: `run-${groupId}`,
        epoch: epoch ?? 0,
        epochFingerprint: `fp-${groupId}-${epoch ?? 0}`,
      }),
      graineSignatureEngine: () => webCryptoEngine,
      // The endorsement of a minted session (WP-G2-5): a fixed device key stands in for the MLS
      // credential, whose own signing is `mls-core`'s and tested there.
      getDeviceId: () => 'dev-a',
      signWithDeviceCredential: (message: Uint8Array) =>
        webCryptoEngine.signWithSessionKey(DEVICE_SECRET, message),
      sendMessage: async (groupId: string, bytes: Uint8Array) => {
        sent.push({ groupId, bytes });
        // What MLS would hand back: the sealed frame, which the session keeps (section 19), and the
        // server's receive time.
        return { sealed: new Uint8Array([0xca, 0xfe]), receivedAt: 1 };
      },
    } as never,
  };
}

function wire(storage: IStorage, mls: ReturnType<typeof fakeMls>['mls'], isPrivate = false): void {
  setGraineRuntime({ storage, deviceKey: () => 'device-key', userId: 'alice', mlsService: mls });
  registerChannelWorkspace(CHANNEL, WS, isPrivate);
}

afterEach(() => setGraineRuntime(null));

describe('sealing', () => {
  it('seals, distributes the seed, and names the session and index on the wire', async () => {
    const { storage } = fakeStorage();
    const { mls, sent } = fakeMls(4);
    wire(storage, mls);

    const sealed = await sealChannelMessage(CHANNEL, new Uint8Array([1, 2, 3]));

    expect(sealed.senderSessionId).toBeTruthy();
    expect(sealed.messageIndex).toBe(0);
    // One frame on the community's distribution group: O(1), whatever the member count.
    expect(sent).toHaveLength(1);
    expect(sent[0].groupId).toBe('g-1');
  });

  it('carries the seed frame on EVERY message of the session, not only the one that minted it', async () => {
    const { storage } = fakeStorage();
    const { mls, sent } = fakeMls(4);
    wire(storage, mls);

    const first = await sealChannelMessage(CHANNEL, new Uint8Array([1]));
    const second = await sealChannelMessage(CHANNEL, new Uint8Array([2]));

    // A push can be withheld (a salon set to mentions), so the first message a phone RECEIVES under a
    // session is not always the first one sent - the frame has to ride them all.
    expect(sent).toHaveLength(1);
    expect(second.senderSessionId).toBe(first.senderSessionId);
    for (const sealed of [first, second]) {
      expect(sealed.seedFrame).toBe('yv4=');
      expect(sealed.seedGroupId).toBe('g-1');
    }
  });

  it('refuses a channel belonging to no community this session loaded', async () => {
    const { storage } = fakeStorage();
    const { mls } = fakeMls(4);
    setGraineRuntime({ storage, deviceKey: () => 'k', userId: 'alice', mlsService: mls });

    // Without the community there is no distribution group, so the seed would reach nobody.
    await expect(sealChannelMessage(CHANNEL, new Uint8Array([1]))).rejects.toBeInstanceOf(
      GraineUnknownChannelError
    );
  });

  it('refuses to seal when the distribution group is not in hand', async () => {
    const { storage } = fakeStorage();
    const { mls } = fakeMls(null);
    wire(storage, mls);

    // Refused HERE rather than discovered separately by every reader of an unreadable message.
    await expect(sealChannelMessage(CHANNEL, new Uint8Array([1]))).rejects.toBeInstanceOf(
      GraineDistributionUnavailableError
    );
  });

  it('produces a ciphertext the pure crypto opens at the index it named', async () => {
    const { storage, rows } = fakeStorage();
    const { mls } = fakeMls(4);
    wire(storage, mls);

    const sealed = await sealChannelMessage(CHANNEL, new Uint8Array([7, 7, 7]));
    const session = rows.get(sealed.senderSessionId)!;

    // Against `openWithGraineV2` itself, not against a mirror of the seal: a round trip through one
    // implementation proves it agrees with itself and nothing more.
    const opened = await openWithGraineV2(
      fromBase64(session.seedB64),
      {
        channelId: CHANNEL,
        sessionId: sealed.senderSessionId,
        minterUserId: 'alice',
        index: sealed.messageIndex,
      },
      { ciphertext: sealed.ciphertext, nonce: sealed.nonce, signature: sealed.signature },
      fromBase64(session.v2!.signingPublicKeyB64),
      webCryptoEngine
    );
    expect([...opened]).toEqual([7, 7, 7]);
  });

  it('endorses the session it mints with this device, so a relayed seed still names its minter', async () => {
    const { storage, rows } = fakeStorage();
    const { mls } = fakeMls(4);
    wire(storage, mls);

    const sealed = await sealChannelMessage(CHANNEL, new Uint8Array([1]));
    const session = rows.get(sealed.senderSessionId)!;

    expect(session.v2?.minterDeviceId).toBe('dev-a');
    // The secret stays on this device, sealed in its store; the wire copy never carries it.
    expect(session.v2?.signingSecretKeyB64).toBeTruthy();
    const verdict = await webCryptoEngine.verifySignature(
      await ed25519PublicKeyOf(DEVICE_SECRET),
      encodeGraineEndorsementV2({
        channelId: CHANNEL,
        sessionId: session.sessionId,
        minterUserId: 'alice',
        minterDeviceId: 'dev-a',
        signingPublicKey: fromBase64(session.v2!.signingPublicKeyB64),
        seedCommitment: await graineSeedCommitment(fromBase64(session.seedB64)),
        createdAt: session.createdAt,
      }),
      fromBase64(session.v2!.endorsementB64)
    );
    expect(verdict).toBe('valid');
  });
});

describe('opening', () => {
  const SEED = toBase64(new Uint8Array(32).fill(9));

  function held(overrides: Partial<StoredGraineSession> = {}): StoredGraineSession {
    return {
      workspaceId: WS,
      channelId: CHANNEL,
      sessionId: 'sess-1',
      senderId: 'bob',
      seedB64: SEED,
      firstIndex: 0,
      createdAt: 1,
      ...overrides,
    };
  }

  it('reports a missing seed as its own type, so a repair can be addressed', async () => {
    const { storage } = fakeStorage();
    wire(storage, fakeMls(4).mls);

    // SIGNED: only a v2 row can be helped by a peer, since a v1 seed is refused on arrival.
    const err = await openChannelMessage(CHANNEL, {
      id: 'row-1',
      senderId: 'bob',
      ciphertext: 'x',
      nonce: 'y',
      signature: 'c2ln',
      senderSessionId: 'sess-unknown',
      messageIndex: 0,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(GraineSessionUnavailableError);
    expect(err.sessionId).toBe('sess-unknown');
  });

  it('reports an UNSIGNED row under a session not held as v1, which no repair can open (section 21.7)', async () => {
    const { storage } = fakeStorage();
    wire(storage, fakeMls(4).mls);

    // A v1 seed is refused on arrival, so asking a peer for this one would fetch a seed this
    // device then refuses - for every such row, for ever.
    const err = await openChannelMessage(CHANNEL, {
      id: 'row-1',
      senderId: 'bob',
      ciphertext: 'x',
      nonce: 'y',
      signature: null,
      senderSessionId: 'sess-v1',
      messageIndex: 0,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(GraineV1SessionNotHeldError);
    expect(err).not.toBeInstanceOf(GraineSessionUnavailableError);
    expect(err.sessionId).toBe('sess-v1');
  });

  it('reports a row that names no session as a missing seed, not as an empty message', async () => {
    const { storage } = fakeStorage();
    wire(storage, fakeMls(4).mls);

    await expect(
      openChannelMessage(CHANNEL, {
        id: 'row-1',
        senderId: 'bob',
        ciphertext: 'x',
        nonce: null,
        senderSessionId: null,
        messageIndex: null,
      })
    ).rejects.toBeInstanceOf(GraineSessionUnavailableError);
  });

  it('separates the handover floor from a missing seed, because one must NOT be repaired', async () => {
    const { storage } = fakeStorage([held({ firstIndex: 40 })]);
    wire(storage, fakeMls(4).mls);

    const err = await openChannelMessage(CHANNEL, {
      id: 'row-1',
      senderId: 'bob',
      ciphertext: 'x',
      nonce: 'y',
      senderSessionId: 'sess-1',
      messageIndex: 12,
    }).catch((e) => e);

    // Asking a peer would return the identical seed with the identical floor, for ever.
    expect(err).toBeInstanceOf(GraineBelowFirstIndexError);
    expect(err.firstIndex).toBe(40);
  });

  it('opens exactly at the floor, which is a message this member IS entitled to', async () => {
    const { storage, rows } = fakeStorage();
    const { mls } = fakeMls(4);
    wire(storage, mls);
    const sealed = await sealChannelMessage(CHANNEL, new Uint8Array([5]));
    const mine = rows.get(sealed.senderSessionId)!;
    rows.set(mine.sessionId, { ...mine, firstIndex: sealed.messageIndex });

    const opened = await openChannelMessage(CHANNEL, {
      id: 'row-1',
      senderId: 'alice',
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      signature: sealed.signature,
      senderSessionId: sealed.senderSessionId,
      messageIndex: sealed.messageIndex,
    });

    // An off-by-one here hides the FIRST message of every handed-over session.
    expect([...opened]).toEqual([5]);
  });
});

describe('a private salon seals on its OWN group', () => {
  it('sends the seed to the salon group, never the community one', async () => {
    const { storage } = fakeStorage();
    const { mls, sent } = fakeMls(4);
    wire(storage, mls, true);

    await sealChannelMessage(CHANNEL, new Uint8Array([1, 2, 3]));

    // The one line that makes a private salon's guarantee cryptographic rather than the server
    // declining to serve its ciphertext: the seed is never even sent to the community's roster.
    expect(sent).toHaveLength(1);
    expect(sent[0].groupId).toBe('g-salon');
  });

  it('names the salon group as the one its seed frame was sealed on', async () => {
    const { storage } = fakeStorage();
    const { mls } = fakeMls(4);
    wire(storage, mls, true);

    const sealed = await sealChannelMessage(CHANNEL, new Uint8Array([1, 2, 3]));

    // The server checks this against the salon's own key group before passing the frame on.
    expect(sealed.seedGroupId).toBe('g-salon');
  });

  it('refuses to seal when the salon group is not in hand, rather than using the community one', async () => {
    const { storage } = fakeStorage();
    const { mls, sent } = fakeMls(4);
    // Community group held, salon group not.
    const mlsWithoutSalon = {
      ...(mls as unknown as Record<string, unknown>),
      getLocalGroups: () => ['g-1'],
    } as never;
    wire(storage, mlsWithoutSalon, true);

    await expect(sealChannelMessage(CHANNEL, new Uint8Array([1]))).rejects.toBeInstanceOf(
      GraineDistributionUnavailableError
    );
    expect(sent).toHaveLength(0);
  });

  it('refuses to seal against a group whose base has not won its race yet', async () => {
    const { storage } = fakeStorage();
    const { mls, sent } = fakeMls(0);
    // Held locally, epoch 0, and still discardable: this device created it moments ago and the
    // server has not said whether its base is the one everyone will join from.
    const unsettled = {
      ...(mls as unknown as Record<string, unknown>),
      isDistributionBaseSettled: () => false,
    } as never;
    wire(storage, unsettled, true);

    // Sealing here mints a session against a group that may cease to exist, and `forgetGroup`
    // would take the session with it - leaving this message unreadable by its own author.
    await expect(sealChannelMessage(CHANNEL, new Uint8Array([1]))).rejects.toBeInstanceOf(
      GraineDistributionUnavailableError
    );
    // And it says WHICH fact was missing, for the toast and the log (production 2026-10-09).
    await expect(sealChannelMessage(CHANNEL, new Uint8Array([1]))).rejects.toMatchObject({
      reason: 'key-group-unsettled',
    });
    expect(sent).toHaveLength(0);
  });
});

/**
 * WP-G2-4: a row under a v2 session is opened only when the server's labels match what the session
 * was endorsed with, the signature covers them, and no other row already showed the same key.
 * Every refusal is a TYPE the unreadable-row accounting files as a fault.
 */
describe('opening a v2 row', () => {
  const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
  const SEED = toBase64(new Uint8Array(32).fill(4));
  const SEED_BYTES = fromBase64(SEED);

  async function v2Session(): Promise<StoredGraineSession> {
    return {
      workspaceId: WS,
      channelId: CHANNEL,
      sessionId: 'sess-v2',
      senderId: 'bob',
      seedB64: SEED,
      firstIndex: 0,
      createdAt: 1,
      v2: {
        minterDeviceId: 'dev-b',
        signingPublicKeyB64: toBase64(await ed25519PublicKeyOf(SECRET)),
        endorsementB64: toBase64(new Uint8Array(64)),
      },
    };
  }

  async function sealedRow(index: number, overrides: { channelId?: string; minter?: string } = {}) {
    const sealed = await sealWithGraineV2(
      SEED_BYTES,
      {
        channelId: overrides.channelId ?? CHANNEL,
        sessionId: 'sess-v2',
        minterUserId: overrides.minter ?? 'bob',
        index,
      },
      new Uint8Array([9, index]),
      SECRET,
      webCryptoEngine
    );
    return {
      id: `row-${index}`,
      senderId: 'bob',
      senderSessionId: 'sess-v2',
      messageIndex: index,
      ...sealed,
    };
  }

  async function wired() {
    const { storage } = fakeStorage([await v2Session()]);
    wire(storage, fakeMls(4).mls);
  }

  it('opens a row the session signed, bound to its salon, author and index', async () => {
    await wired();
    const opened = await openChannelMessage(CHANNEL, await sealedRow(3));
    expect([...opened]).toEqual([9, 3]);
  });

  it('refuses a row the server re-attributes to someone else', async () => {
    await wired();
    const err = await openChannelMessage(CHANNEL, {
      ...(await sealedRow(3)),
      senderId: 'mallory',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GraineAuthorMismatchError);
    expect(err.minter).toBe('bob');
  });

  it('refuses a row served in another salon than its session', async () => {
    await wired();
    registerChannelWorkspace('chan-2', WS, false);
    const err = await openChannelMessage('chan-2', await sealedRow(3)).catch((e) => e);
    expect(err).toBeInstanceOf(GraineChannelMismatchError);
  });

  it('refuses a row moved to another index, or whose signature was stripped', async () => {
    await wired();
    const moved = await openChannelMessage(CHANNEL, {
      ...(await sealedRow(3)),
      messageIndex: 4,
    }).catch((e) => e);
    expect(moved).toBeInstanceOf(GraineSignatureError);

    const stripped = await openChannelMessage(CHANNEL, {
      ...(await sealedRow(5)),
      signature: null,
    }).catch((e) => e);
    // The version belongs to the session, so dropping the signature is not a downgrade to v1.
    expect(stripped).toBeInstanceOf(GraineSignatureError);
  });

  it('refuses a row a member signed with a header naming another minter', async () => {
    await wired();
    const err = await openChannelMessage(CHANNEL, await sealedRow(3, { minter: 'carol' })).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(GraineSignatureError);
  });

  it('shows a replayed key once: the same row twice is fine, a second row is refused', async () => {
    await wired();
    const row = await sealedRow(6);
    await openChannelMessage(CHANNEL, row);
    await expect(openChannelMessage(CHANNEL, row)).resolves.toBeTruthy();

    const err = await openChannelMessage(CHANNEL, { ...row, id: 'row-replayed' }).catch((e) => e);
    expect(err).toBeInstanceOf(GraineReplayError);
    expect(err.firstRowId).toBe('row-6');
  });

  it('never lets a forged row claim a key before the real one', async () => {
    await wired();
    const real = await sealedRow(7);
    const forged = { ...real, id: 'row-forged', ciphertext: toBase64(new Uint8Array(20)) };
    await expect(openChannelMessage(CHANNEL, forged)).rejects.toBeInstanceOf(GraineSignatureError);
    await expect(openChannelMessage(CHANNEL, real)).resolves.toBeTruthy();
  });

  /**
   * F7: a page opened with ONE engine call answers every row exactly what the single open answers
   * it - same plaintext, or the same typed throw with the same sentence - including the ordering
   * facts (a forged row before the real one, a replay after the original).
   */
  describe('as a page, with one engine call', () => {
    const V1_SEED = new Uint8Array(32).fill(6);

    async function v1Row(index: number): Promise<OpenableChannelMessage> {
      const key = await crypto.subtle.importKey(
        'raw',
        (await deriveMessageKeyBytes(V1_SEED, 'sess-v1-held', index)) as BufferSource,
        { name: 'AES-GCM' },
        false,
        ['encrypt']
      );
      const nonce = new Uint8Array(12).fill(index);
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce as BufferSource },
        key,
        new Uint8Array([1, index]) as BufferSource
      );
      return {
        id: `v1-${index}`,
        senderId: 'carol',
        ciphertext: toBase64(new Uint8Array(ciphertext)),
        nonce: toBase64(nonce),
        senderSessionId: 'sess-v1-held',
        messageIndex: index,
        signature: null,
      };
    }

    /** Every kind of row a page can hold, in an order where the order matters. */
    async function mixedPage(): Promise<OpenableChannelMessage[]> {
      const real2 = await sealedRow(2);
      const sig8 = (await sealedRow(8)).signature;
      return [
        await sealedRow(1),
        // A forged row BEFORE the real one: refused, and the real one still claims the key.
        { ...real2, id: 'row-forged', ciphertext: toBase64(new Uint8Array(20)) },
        real2,
        { ...(await sealedRow(3)), senderId: 'mallory' },
        { ...(await sealedRow(4)), signature: 'c2ln' },
        { ...(await sealedRow(5)), signature: null },
        { ...(await sealedRow(6)), senderSessionId: 'sess-unknown' },
        {
          id: 'v1-unknown',
          senderId: 'bob',
          ciphertext: 'x',
          nonce: 'y',
          senderSessionId: 'sess-v1-missing',
          messageIndex: 0,
          signature: null,
        },
        // A replay of row 1 under another id, AFTER it.
        { ...(await sealedRow(1)), id: 'row-replayed' },
        // Row 9 carrying row 8's signature: a moved index.
        { ...(await sealedRow(9)), signature: sig8 },
        await v1Row(3),
        { ...(await sealedRow(12)), senderSessionId: 'sess-floor' },
        await sealedRow(13),
      ];
    }

    async function wiredWithEngine() {
      const v2 = await v2Session();
      const { storage } = fakeStorage([
        v2,
        { ...v2, sessionId: 'sess-floor', firstIndex: 40 },
        {
          workspaceId: WS,
          channelId: CHANNEL,
          sessionId: 'sess-v1-held',
          senderId: 'carol',
          seedB64: toBase64(V1_SEED),
          firstIndex: 0,
          createdAt: 1,
        },
      ]);
      const engine = {
        ...webCryptoEngine,
        verifySignature: vi.fn(webCryptoEngine.verifySignature),
        verifySignatures: vi.fn(webCryptoEngine.verifySignatures),
      };
      const mls = {
        ...(fakeMls(4).mls as Record<string, unknown>),
        graineSignatureEngine: () => engine,
      };
      wire(storage, mls as never);
      return engine;
    }

    function outcome(r: { ok: true; bytes: Uint8Array } | { ok: false; error: unknown }) {
      return r.ok
        ? { bytes: [...r.bytes] }
        : { error: (r.error as Error).constructor.name, message: (r.error as Error).message };
    }

    it('answers each row what the single open answers it, with ONE engine call', async () => {
      const page = await mixedPage();

      const engine = await wiredWithEngine();
      const batched = (await openChannelMessagePage(CHANNEL, page)).map(outcome);
      expect(engine.verifySignatures).toHaveBeenCalledTimes(1);
      expect(engine.verifySignature).not.toHaveBeenCalled();
      // Only the rows that reached the check were in it: 1, forged 2, 2, the replay of 1, 9, 13.
      expect(engine.verifySignatures.mock.calls[0][0]).toHaveLength(6);

      setGraineRuntime(null);
      const single: ReturnType<typeof outcome>[] = [];
      await wiredWithEngine();
      for (const row of page) {
        single.push(
          await openChannelMessage(CHANNEL, row).then(
            (bytes) => outcome({ ok: true, bytes }),
            (error: unknown) => outcome({ ok: false, error })
          )
        );
      }
      expect(batched).toEqual(single);
      // And the facts themselves, so the two cannot agree on being wrong.
      expect(batched.map((o) => ('bytes' in o ? 'ok' : o.error))).toEqual([
        'ok',
        'GraineSignatureError',
        'ok',
        'GraineAuthorMismatchError',
        'GraineSignatureError',
        'GraineSignatureError',
        'GraineSessionUnavailableError',
        'GraineV1SessionNotHeldError',
        'GraineReplayError',
        'GraineSignatureError',
        'ok',
        'GraineBelowFirstIndexError',
        'ok',
      ]);
    });

    it('makes no engine call for a page with nothing to verify', async () => {
      const engine = await wiredWithEngine();
      const out = await openChannelMessagePage(CHANNEL, [await v1Row(1), await v1Row(2)]);
      expect(out.every((o) => o.ok)).toBe(true);
      expect(engine.verifySignatures).not.toHaveBeenCalled();
    });

    it('splits a page larger than one batch, every verdict still landing on its own row', async () => {
      const engine = await wiredWithEngine();
      const rows = await Promise.all(
        Array.from({ length: GRAINE_SIGNATURE_BATCH_MAX + 3 }, (_, i) => sealedRow(100 + i))
      );
      // One forged row in the second batch refuses itself only.
      const forgedAt = GRAINE_SIGNATURE_BATCH_MAX + 1;
      rows[forgedAt] = { ...rows[forgedAt], ciphertext: toBase64(new Uint8Array(20)) };
      const out = await openChannelMessagePage(CHANNEL, rows);
      expect(engine.verifySignatures).toHaveBeenCalledTimes(2);
      expect(out.filter((o) => !o.ok)).toHaveLength(1);
      expect(out[forgedAt].ok).toBe(false);
      // 259 real seals: the budget is for a loaded test runner, not a claim about speed.
    }, 30_000);

    it('keeps a failed batch to its own rows: the next batch is still asked and believed', async () => {
      const engine = await wiredWithEngine();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const rows = await Promise.all(
        Array.from({ length: GRAINE_SIGNATURE_BATCH_MAX + 2 }, (_, i) => sealedRow(600 + i))
      );
      engine.verifySignatures.mockRejectedValueOnce(new Error('bridge down'));
      const out = await openChannelMessagePage(CHANNEL, rows);
      expect(engine.verifySignatures).toHaveBeenCalledTimes(2);
      expect(out.filter((o) => !o.ok)).toHaveLength(GRAINE_SIGNATURE_BATCH_MAX);
      expect(out.slice(GRAINE_SIGNATURE_BATCH_MAX).every((o) => o.ok)).toBe(true);
      error.mockRestore();
    }, 30_000);

    it('gives a failed engine call to every row waiting on it, and nothing else', async () => {
      const engine = await wiredWithEngine();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      engine.verifySignatures.mockRejectedValueOnce(new Error('bridge down'));
      const out = await openChannelMessagePage(CHANNEL, [await sealedRow(1), await v1Row(2)]);
      expect(out[0]).toMatchObject({ ok: false, error: new Error('bridge down') });
      expect(out[1].ok).toBe(true);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('[GRAINE] signature batch'));
      error.mockRestore();
    });

    it('believes no verdict from an engine that answers the wrong count', async () => {
      const engine = await wiredWithEngine();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      engine.verifySignatures.mockResolvedValueOnce(['valid']);
      const out = await openChannelMessagePage(CHANNEL, [await sealedRow(1), await sealedRow(2)]);
      expect(out.every((o) => !o.ok && o.error instanceof GraineSignatureBatchError)).toBe(true);
      // Nor from one of the right length that holds something no engine answers.
      engine.verifySignatures.mockResolvedValueOnce(['valid', 'ok'] as never);
      const odd = await openChannelMessagePage(CHANNEL, [await sealedRow(3), await sealedRow(4)]);
      expect(odd.every((o) => !o.ok && o.error instanceof GraineSignatureBatchError)).toBe(true);
      error.mockRestore();
    });
  });
});
