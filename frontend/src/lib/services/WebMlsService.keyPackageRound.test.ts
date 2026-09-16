/**
 * A KEY-PACKAGE ROUND THAT MINTS NOTHING MUST NOT TOUCH THE STATE, AND THAT IS THE ORDINARY ROUND.
 *
 * Read on the user's own production console, 2026-09-16 13:32, an ordinary F5:
 *
 *     [MLS] generateKeyPackage via worker (under mlsLock)
 *     [MLS Worker] generateKeyPackage start needed=0
 *     [MLS] Encrypted state checkpoint persisted. (153 ms)
 *     [RUST::INFO] load_or_create: state composition - 7539305B total; ...   <- in the WORKER
 *     [MLS] Encrypted state checkpoint persisted. (65 ms)
 *     [RUST::INFO] load_or_create: state composition - 7539305B total; ...   <- and again, main thread
 *     [MLS] Encrypted state checkpoint persisted. (63 ms)
 *     KeyPackage published.
 *
 * `needed=0` - the server's pool was full - and the held last-resort was still valid, so the round
 * created no private bundle whatsoever. It still spent a `save_state` over 7 539 303 B, a worker
 * that decrypted the whole state, a `reloadClientFromState` that decrypted it a second time, and
 * three encrypted checkpoints, to publish bytes the delivery service already held.
 *
 * The write exists to make a NEW private bundle durable before its public half is published. With
 * nothing minted there is no new bundle, the state after equals the state before, and the whole
 * round is one HTTP publish.
 */
vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));
vi.mock('$lib/mls-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAndInitWasm: vi.fn().mockResolvedValue({ tag: 'wasm-client' }),
}));

const persistMlsStructuralCheckpoint = vi.fn().mockResolvedValue(undefined);
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  persistMlsStructuralCheckpoint: (...args: unknown[]) => persistMlsStructuralCheckpoint(...args),
}));

import { WebMlsService } from './WebMlsService';

const HELD = new Uint8Array([0xbe, 0xef]);
const MINTED = new Uint8Array([0xfa]);
/** 84 days out, which is what openmls stamps on a package it mints. */
const NOT_AFTER = Math.floor(Date.now() / 1000) + 84 * 24 * 60 * 60;

/**
 * A minted binding as wasm-bindgen hands it over: the bytes, the expiry, and a `free` that MUST be
 * called exactly once. The mock carries the real shape rather than a bare `Uint8Array` because the
 * free is the half a test can get wrong silently - a binding nobody releases is a slot of linear
 * memory held for the life of the tab, fifty-one of them per round.
 */
const dated = (bytes: Uint8Array) => ({
  public: bytes,
  notAfterSecs: NOT_AFTER,
  free: vi.fn(),
  [Symbol.dispose]: vi.fn(),
});

function makeCtx(opts: { poolOnServer: number; held?: Uint8Array }) {
  const saveState = vi.fn(() => new Uint8Array(16));
  const publishKeyPackage = vi.fn().mockResolvedValue(undefined);
  const publishKeyPackages = vi.fn().mockResolvedValue(undefined);
  const client = {
    save_state: saveState,
    existing_last_resort_key_package: vi.fn((_now: bigint) =>
      opts.held ? dated(opts.held) : undefined
    ),
    generate_last_resort_key_package: vi.fn(() => dated(MINTED)),
    generate_key_packages: vi.fn((n: number) =>
      Array.from({ length: n }, (_, i) => dated(new Uint8Array([i])))
    ),
  };
  return {
    ctx: {
      freshStart: false,
      // The main-thread branch, so the assertions are about the STATE WRITE and not about a worker
      // harness: the worker path pays for everything this one does and a round trip besides.
      useKeyPackageWorker: false,
      client,
      delivery: { fetchPrekeyCount: vi.fn().mockResolvedValue(opts.poolOnServer) },
      publishKeyPackage,
      publishKeyPackages,
    },
    client,
    saveState,
    publishKeyPackage,
    publishKeyPackages,
  };
}

const round = (ctx: unknown): Promise<{ bytes: Uint8Array; notAfterSecs: number }> =>
  (
    WebMlsService.prototype as unknown as {
      generateKeyPackageImpl(k: string): Promise<{ bytes: Uint8Array; notAfterSecs: number }>;
    }
  ).generateKeyPackageImpl.call(ctx, 'device-key');

describe('a key package round that mints nothing writes nothing', () => {
  beforeEach(() => persistMlsStructuralCheckpoint.mockClear());

  it('skips the checkpoint entirely when the pool is full and the last-resort is held', async () => {
    const { ctx, client, publishKeyPackage, publishKeyPackages } = makeCtx({
      poolOnServer: 50,
      held: HELD,
    });

    const fallback = await round(ctx);

    expect(persistMlsStructuralCheckpoint).not.toHaveBeenCalled();
    expect(client.generate_key_packages).not.toHaveBeenCalled();
    expect(client.generate_last_resort_key_package).not.toHaveBeenCalled();
    // The publish still happens: it is the one thing this round is for, and it is an HTTP call
    // over bytes already on disk.
    expect(publishKeyPackage).toHaveBeenCalledWith({ bytes: HELD, notAfterSecs: NOT_AFTER });
    expect(publishKeyPackages).not.toHaveBeenCalled();
    expect(fallback).toEqual({ bytes: HELD, notAfterSecs: NOT_AFTER });
  });

  it('does not even ask the state for a snapshot on that round', async () => {
    // The worker branch opens with `this.client.save_state(deviceKeyB64)` over the whole state.
    // Asserting on the main-thread branch's client proves the round returned before ANY state
    // capture, which is what the worker branch would have gone on to pay for.
    const { ctx, saveState } = makeCtx({ poolOnServer: 50, held: HELD });
    await round(ctx);
    expect(saveState).not.toHaveBeenCalled();
  });

  it('releases the binding it read, because nothing else will', async () => {
    // A wasm-bindgen class owns a slot in the linear memory until it is freed, and the getters
    // copy - so the plain object the round returns outlives the free and the slot does not have to.
    // This is asserted HERE and not only on `keyPackages.test.ts` because this file is the one that
    // exercises the round end to end, and it is the file that went on returning bare `Uint8Array`s
    // after the mint started handing over bindings: CI caught it with `dated.free is not a
    // function`, which is what a mock shaped like the real thing is for.
    const { ctx, client } = makeCtx({ poolOnServer: 50, held: HELD });
    await round(ctx);
    const handed = client.existing_last_resort_key_package.mock.results[0].value;
    expect(handed.free).toHaveBeenCalledTimes(1);
  });

  it('asks for the held package with a BigInt, because the binding takes a u64', async () => {
    // A Number does not convert there, it THROWS - `BigInt.asUintN` rejects any Number, integral or
    // not. That defect once stopped every web client publishing a key package at all, and this
    // round now reads the clock on a second seam where it can happen again.
    const { ctx, client } = makeCtx({ poolOnServer: 50, held: HELD });
    await round(ctx);
    const asked = client.existing_last_resort_key_package.mock.calls[0][0];
    expect(typeof asked).toBe('bigint');
    expect(Math.abs(Number(asked) - Date.now() / 1000)).toBeLessThan(5);
  });
});

describe('a round that does mint still pays for the write it owes', () => {
  beforeEach(() => persistMlsStructuralCheckpoint.mockClear());

  it('checkpoints when the pool needs topping up', async () => {
    const { ctx, client, publishKeyPackages } = makeCtx({ poolOnServer: 48, held: HELD });

    await round(ctx);

    expect(client.generate_key_packages).toHaveBeenCalledWith(2);
    // AWAITED BEFORE THE PUBLISH: a key package whose private half is not on disk is a
    // `NoMatchingKeyPackage` waiting for the first peer that consumes it.
    expect(persistMlsStructuralCheckpoint).toHaveBeenCalledTimes(1);
    expect(publishKeyPackages).toHaveBeenCalledTimes(1);
  });

  it('checkpoints when the last-resort has expired, even with the pool full', async () => {
    // The two halves of the round are independent: a full pool says nothing about the fallback,
    // whose rotation is its own 84-day lifetime since #458.
    const { ctx, client, publishKeyPackage } = makeCtx({ poolOnServer: 50, held: undefined });

    const fallback = await round(ctx);

    expect(client.generate_last_resort_key_package).toHaveBeenCalledTimes(1);
    expect(persistMlsStructuralCheckpoint).toHaveBeenCalledTimes(1);
    expect(publishKeyPackage).toHaveBeenCalledWith({ bytes: MINTED, notAfterSecs: NOT_AFTER });
    expect(fallback).toEqual({ bytes: MINTED, notAfterSecs: NOT_AFTER });
  });
});
