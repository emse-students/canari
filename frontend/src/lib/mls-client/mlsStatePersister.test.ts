import { createMlsStatePersister } from './mlsStatePersister';
import {
  registerMlsStatePersister,
  unregisterMlsStatePersister,
  scheduleOutboundMlsPersist,
  persistMlsStructuralCheckpoint,
} from './mlsStatePersisterRegistry';
import { flushMacrotask } from '../../test/flush';
import { MlsStateWriteRefusedError } from '$lib/utils/hex';
import { Log } from '$lib/utils/Log';

vi.mock('$lib/utils/scheduling/yieldToMainThread', () => ({
  yieldToMainThread: vi.fn().mockResolvedValue(undefined),
}));

describe('createMlsStatePersister', () => {
  afterEach(() => {
    unregisterMlsStatePersister();
  });

  function makePersister() {
    const persistCheckpoint = vi.fn().mockResolvedValue(undefined);
    const persister = createMlsStatePersister({
      mlsService: { persistCheckpoint } as any,
    });
    return { persistCheckpoint, persister };
  }

  it('scheduleDeferred marks dirty without writing to disk', async () => {
    const { persistCheckpoint, persister } = makePersister();
    persister.scheduleDeferred();
    persister.scheduleDeferred();
    await flushMacrotask();
    expect(persistCheckpoint).not.toHaveBeenCalled();
  });

  it('coalesces persistNow calls in the same tick (encrypted)', async () => {
    const { persistCheckpoint, persister } = makePersister();
    persister.persistNow();
    persister.persistNow();
    await persister.flush();
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
    expect(persistCheckpoint).toHaveBeenCalledWith();
  });

  it('writes the state ONCE per checkpoint - the platform owns where it lands', async () => {
    // This used to be `saveState` then `saveMlsStateEncrypted`, which is one durable write on web
    // and TWO on native: `sauvegarder_mls_et_persister` has already written `mls.bin` when it
    // returns, so handing its bytes to `save_mls_state` wrote the same file again, marshalled
    // through IPC as a `number[]`. 2.0 s of a 3.7 s checkpoint on the phone, measured 2026-08-14.
    const { persistCheckpoint, persister } = makePersister();
    persister.persistNow();
    await persister.flush();
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('defers disk writes during bulk ingest and flushes encrypted at end', async () => {
    const { persistCheckpoint, persister } = makePersister();
    persister.onBulkIngestStart();
    persister.scheduleDeferred();
    persister.persistNow();
    await flushMacrotask();
    expect(persistCheckpoint).not.toHaveBeenCalled();

    await persister.onBulkIngestEnd();
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('closes the ingest window WITHOUT waiting for the checkpoint - durability must not gate delivery', async () => {
    // The pipeline awaits every bulk-ingest observer, so a checkpoint awaited here is a checkpoint
    // charged to the next message's latency: measured at 8.0 s on a cold web client and 3.2 s on the
    // phone, with the frame already received and sitting undecrypted behind it.
    let release: () => void = () => {};
    const persistCheckpoint = vi
      .fn()
      .mockImplementation(() => new Promise<void>((r) => (release = () => r())));
    const persister = createMlsStatePersister({
      mlsService: { persistCheckpoint } as any,
    });

    persister.onBulkIngestStart();
    persister.persistNow();

    let ended = false;
    void persister.onBulkIngestEnd().then(() => (ended = true));
    await flushMacrotask();

    // The window is closed while the disk write is still in flight - that is the whole point.
    expect(ended).toBe(true);
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);

    release();
    await flushMacrotask();
  });

  it('a checkpoint that FAILS after the window closed does not reject into the pipeline', async () => {
    // Unawaited work still has to be caught: an unhandled rejection reaching the window would take
    // down the very pipeline this change decoupled.
    const persistCheckpoint = vi.fn().mockRejectedValue(new Error('disk gone'));
    const persister = createMlsStatePersister({
      mlsService: { persistCheckpoint } as any,
    });

    persister.onBulkIngestStart();
    persister.persistNow();
    await expect(persister.onBulkIngestEnd()).resolves.toBeUndefined();
    await flushMacrotask();
  });

  // The wait IS the finding, so it is named rather than tolerated: the write is queued on a
  // microtask and the call returns `void`, so no caller can await it and none does (the test waits
  // for the WRITE, never for a duration). This shortens
  // the window in which a reload would restore a ratchet behind the frames already sent; what
  // CLOSES that window is the send ledger, asserted in `BaseMlsService.sendSeam.test.ts`.
  it('scheduleOutboundMlsPersist reaches disk EVENTUALLY, on a microtask nobody awaits', async () => {
    const { persistCheckpoint, persister } = makePersister();
    registerMlsStatePersister(persister);
    expect(scheduleOutboundMlsPersist()).toBeUndefined();
    expect(persistCheckpoint).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(persistCheckpoint).toHaveBeenCalledTimes(1));
  });

  it('coalesces a burst of outbound sends into one checkpoint', async () => {
    const { persistCheckpoint, persister } = makePersister();
    registerMlsStatePersister(persister);
    scheduleOutboundMlsPersist();
    scheduleOutboundMlsPersist();
    scheduleOutboundMlsPersist();
    await flushMacrotask();
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('outbound sends during a bulk ingest wait for the ingest to end', async () => {
    const { persistCheckpoint, persister } = makePersister();
    registerMlsStatePersister(persister);
    persister.onBulkIngestStart();
    scheduleOutboundMlsPersist();
    await flushMacrotask();
    expect(persistCheckpoint).not.toHaveBeenCalled();
    await persister.onBulkIngestEnd();
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('flushEncrypted persists after scheduleDeferred marked dirty', async () => {
    const { persistCheckpoint, persister } = makePersister();
    persister.scheduleDeferred();
    await persister.flushEncrypted();
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  /**
   * A checkpoint EXPORTS the state when it starts. A caller that changed the state after that and
   * asks for durability must wait for the NEXT checkpoint - `externalJoin` awaits this, because a
   * reload before its join is on disk joins again and forks the group. It used to be handed the
   * running checkpoint, which resolved without the join (Mi 9T sign-in, 2026-10-13: a checkpoint was
   * running 93 % of the time, so nearly every join of the storm was declared durable too early).
   */
  describe('a flush asked while a checkpoint is running', () => {
    function controlled() {
      let version = 1;
      const written: number[] = [];
      const releases: Array<() => void> = [];
      const persistCheckpoint = vi.fn().mockImplementation(() => {
        const exported = version;
        return new Promise<void>((resolve) => {
          releases.push(() => {
            written.push(exported);
            resolve();
          });
        });
      });
      const persister = createMlsStatePersister({ mlsService: { persistCheckpoint } as any });
      return {
        persister,
        persistCheckpoint,
        written,
        mutate: () => (version += 1),
        releaseNext: async () => {
          releases.shift()?.();
          await flushMacrotask();
        },
      };
    }

    it('resolves only once a checkpoint that exported AFTER the change is written', async () => {
      const c = controlled();
      c.persister.scheduleDeferred();
      void c.persister.flush(); // checkpoint A exports version 1
      await flushMacrotask();

      c.mutate(); // the join lands: version 2
      c.persister.scheduleDeferred();
      let durable = false;
      const join = c.persister.flush().then(() => (durable = true));

      await c.releaseNext(); // A written - it holds version 1, not the join
      expect(c.written).toEqual([1]);
      expect(durable).toBe(false);

      await c.releaseNext(); // B written - it holds the join
      await join;
      expect(c.written).toEqual([1, 2]);
      expect(durable).toBe(true);
    });

    it('still shares ONE next checkpoint between every caller that arrived during the running one', async () => {
      const c = controlled();
      c.persister.scheduleDeferred();
      void c.persister.flush();
      await flushMacrotask();

      const waits = [];
      for (let i = 0; i < 5; i++) {
        c.mutate();
        c.persister.scheduleDeferred();
        waits.push(c.persister.flush());
      }
      await c.releaseNext();
      await c.releaseNext();
      await Promise.all(waits);

      expect(c.persistCheckpoint).toHaveBeenCalledTimes(2);
      expect(c.written).toEqual([1, 6]);
    });

    it('is covered by the running checkpoint when nothing changed since it exported', async () => {
      const c = controlled();
      c.persister.scheduleDeferred();
      void c.persister.flush();
      await flushMacrotask();

      const wait = c.persister.flush();
      await c.releaseNext();
      await wait;

      expect(c.persistCheckpoint).toHaveBeenCalledTimes(1);
    });
  });

  it('a checkpoint that FAILED leaves the state dirty, so the next flush writes it', async () => {
    const persistCheckpoint = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const persister = createMlsStatePersister({ mlsService: { persistCheckpoint } as any });

    persister.scheduleDeferred();
    await expect(persister.flush()).rejects.toThrow('disk full');
    await persister.flush();

    expect(persistCheckpoint).toHaveBeenCalledTimes(2);
  });

  it('a checkpoint REFUSED by the version guard rejects typed, stays dirty, and adds no line', async () => {
    // The guard has said it in the one line that names both versions; the persister repeating it
    // was the second of four lines per refusal.
    const log = vi.fn();
    const persistCheckpoint = vi
      .fn()
      .mockRejectedValueOnce(new MlsStateWriteRefusedError('collision'))
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const persister = createMlsStatePersister({ mlsService: { persistCheckpoint } as any, log });

    persister.scheduleDeferred();
    await expect(persister.flush()).rejects.toBeInstanceOf(MlsStateWriteRefusedError);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('checkpoint failed'));

    // Still dirty, so the next flush writes it; a failure of another kind is still reported.
    await expect(persister.flush()).rejects.toThrow('disk full');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('checkpoint failed'));
    expect(persistCheckpoint).toHaveBeenCalledTimes(2);
  });

  it('a checkpoint refused for want of the leader copy does NOT stay dirty: asked again, nothing runs', async () => {
    // Review of #3326: re-raising the flag made every visibility change in a follower ask again,
    // which turned the refusal said once into a refusal said per flush.
    const persistCheckpoint = vi
      .fn()
      .mockRejectedValue(new MlsStateWriteRefusedError('not-leader'));
    const persister = createMlsStatePersister({ mlsService: { persistCheckpoint } as any });

    persister.scheduleDeferred();
    await expect(persister.flushEncrypted()).rejects.toBeInstanceOf(MlsStateWriteRefusedError);
    await persister.flushEncrypted();

    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('scheduleOutboundMlsPersist is a no-op without a registered persister', () => {
    expect(() => scheduleOutboundMlsPersist()).not.toThrow();
  });
});

describe('persistMlsStructuralCheckpoint', () => {
  afterEach(() => {
    unregisterMlsStatePersister();
  });

  it('uses the active persister when registered', async () => {
    const persistCheckpoint = vi.fn().mockResolvedValue(undefined);
    const persister = createMlsStatePersister({
      mlsService: { persistCheckpoint } as any,
    });
    registerMlsStatePersister(persister);

    await persistMlsStructuralCheckpoint();

    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  /**
   * THE PERSISTER MUST NOT KNOW THE DEVICE KEY, and this is the assertion that keeps it that way.
   *
   * It used to take one in its config, read from `ctx.getDeviceKey()` at the single moment
   * `setupMessageHandler` ran. Nothing rebuilds it, so an in-session PIN change left it holding the
   * key the account had stopped using: `performPinChange` re-sealed the MLS state under the new key
   * and the very next checkpoint - any commit, any bulk-ingest end - overwrote that blob with one
   * sealed under the old one. The next launch could not open its own state and the user was told
   * their PIN had been changed on another device, on the device that changed it.
   *
   * Passing NO argument is the fix and the test: a call site that cannot pass a key cannot pass a
   * stale one, and `BaseMlsService` - the object whose state is being sealed - is the one owner.
   */
  it('asks for a checkpoint without naming a key, so it cannot name a stale one', async () => {
    const persistCheckpoint = vi.fn().mockResolvedValue(undefined);
    const persister = createMlsStatePersister({ mlsService: { persistCheckpoint } as any });
    persister.persistNow();
    await persister.flush();
    expect(persistCheckpoint).toHaveBeenCalledWith();
    expect(persistCheckpoint.mock.calls[0]).toEqual([]);
  });

  it('falls back to the platform checkpoint when no persister is registered', async () => {
    const persistCheckpoint = vi.fn().mockResolvedValue(undefined);

    await persistMlsStructuralCheckpoint({
      mlsService: { persistCheckpoint } as any,
    });

    expect(persistCheckpoint).toHaveBeenCalledWith();
  });
});

describe('createMlsStatePersister - receive checkpoint skip (WP-CHECKPOINT-SKIP)', () => {
  const live = { bufferUi: true, showOverlay: false };
  const replay = { bufferUi: false, showOverlay: false };

  function make(receiveSkipBudget?: number, persistImpl?: () => Promise<void>) {
    const persistCheckpoint = vi.fn(persistImpl ?? (() => Promise.resolve()));
    const persister = createMlsStatePersister({
      mlsService: { persistCheckpoint } as any,
      receiveSkipBudget: receiveSkipBudget === undefined ? undefined : () => receiveSkipBudget,
    });
    return { persistCheckpoint, persister };
  }

  async function drain(persister: ReturnType<typeof make>['persister'], frames = 1, phase = live) {
    persister.onBulkIngestStart();
    for (let i = 0; i < frames; i++) persister.scheduleDeferred();
    await persister.onBulkIngestEnd(phase);
    await flushMacrotask();
  }

  it('OFF (default) checkpoints after every drain, exactly as before', async () => {
    for (const budget of [undefined, 0]) {
      const { persistCheckpoint, persister } = make(budget);
      for (let i = 0; i < 5; i++) await drain(persister);
      await drain(persister, 1, replay);
      expect(persistCheckpoint).toHaveBeenCalledTimes(6);
    }
  });

  it('ON skips live receive-only drains while fewer than the budget of FRAMES are unsaved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { persistCheckpoint, persister } = make(3);
    await drain(persister);
    await drain(persister);
    expect(persistCheckpoint).not.toHaveBeenCalled();
    await drain(persister);
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
    await drain(persister);
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('ON counts frames, not drains: one catch-up drain past the budget checkpoints at once', async () => {
    const { persistCheckpoint, persister } = make(50);
    await drain(persister, 400);
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('ON never skips a drain that asked for durability (commit, Welcome, structural change)', async () => {
    const { persistCheckpoint, persister } = make(10);
    persister.onBulkIngestStart();
    persister.persistNow();
    await persister.onBulkIngestEnd(live);
    await flushMacrotask();
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('ON never skips a history-replay window, which saves a cursor of its own', async () => {
    const { persistCheckpoint, persister } = make(10);
    await drain(persister, 1, replay);
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('ON: a replay window closing inside a live drain makes the outermost close checkpoint', async () => {
    const { persistCheckpoint, persister } = make(10);
    persister.onBulkIngestStart();
    persister.onBulkIngestStart();
    persister.scheduleDeferred();
    await persister.onBulkIngestEnd(replay);
    await persister.onBulkIngestEnd(live);
    await flushMacrotask();
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('ON: after a failed write the owed urgency survives, so the retry is not skipped', async () => {
    let fail = true;
    const { persistCheckpoint, persister } = make(10, () =>
      fail ? Promise.reject(new Error('disk')) : Promise.resolve()
    );
    persister.persistNow();
    await flushMacrotask();
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
    fail = false;
    await drain(persister);
    expect(persistCheckpoint).toHaveBeenCalledTimes(2);
  });

  it('ON still writes the skipped state on an explicit flush (background, logout, send)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { persistCheckpoint, persister } = make(10);
    await drain(persister);
    expect(persistCheckpoint).not.toHaveBeenCalled();
    await persister.flush();
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });
});

describe('createMlsStatePersister - the switch is read at every drain end', () => {
  const live = { bufferUi: true, showOverlay: false };
  const replay = { bufferUi: false, showOverlay: false };

  afterEach(() => vi.restoreAllMocks());

  /** A persister whose budget is whatever `state.budget` holds when a drain ends. */
  function makeSwitchable(persistImpl?: () => Promise<void>) {
    const state = { budget: 0 };
    const lines: string[] = [];
    const persistCheckpoint = vi.fn(persistImpl ?? (() => Promise.resolve()));
    const persister = createMlsStatePersister({
      mlsService: { persistCheckpoint } as any,
      log: (msg) => lines.push(msg),
      receiveSkipBudget: () => state.budget,
    });
    return { state, lines, persistCheckpoint, persister };
  }

  async function drain(persister: ReturnType<typeof makeSwitchable>['persister'], frames = 1) {
    persister.onBulkIngestStart();
    for (let i = 0; i < frames; i++) persister.scheduleDeferred();
    await persister.onBulkIngestEnd(live);
    await flushMacrotask();
  }

  it('OFF -> ON mid-session: drains checkpoint, then defer once the server says on', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { state, persistCheckpoint, persister } = makeSwitchable();
    await drain(persister);
    await drain(persister);
    expect(persistCheckpoint).toHaveBeenCalledTimes(2);
    state.budget = 100;
    await drain(persister);
    await drain(persister);
    expect(persistCheckpoint).toHaveBeenCalledTimes(2);
  });

  it('ON -> OFF mid-session: the next drain checkpoints everything the skipped ones left', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { state, persistCheckpoint, persister } = makeSwitchable();
    state.budget = 100;
    await drain(persister, 3);
    await drain(persister, 3);
    expect(persistCheckpoint).not.toHaveBeenCalled();
    state.budget = 0;
    await drain(persister);
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('a replay that closed inside a live drain while OFF still forces the outer close once ON', async () => {
    const { state, persistCheckpoint, persister } = makeSwitchable();
    persister.onBulkIngestStart();
    persister.onBulkIngestStart();
    persister.scheduleDeferred();
    await persister.onBulkIngestEnd(replay);
    state.budget = 100;
    await persister.onBulkIngestEnd(live);
    await flushMacrotask();
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('OFF logs exactly what it always logged: no switch line, no summary, no debug, no warn', async () => {
    const debug = vi.spyOn(Log, 'd').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { lines, persister } = makeSwitchable();
    await drain(persister);
    expect(lines).toEqual([
      '[MLS] Disk writes deferred (bulk ingest depth=1)',
      '[MLS] Bulk ingest done - flushing an encrypted checkpoint if needed.',
      expect.stringMatching(/^\[MLS\] Encrypted state checkpoint persisted\.( \(\d+ ms\))?$/),
    ]);
    expect(debug).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('ON: one debug line per deferred drain, never a warn, and one counted summary on the checkpoint', async () => {
    const debug = vi.spyOn(Log, 'd').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { state, lines, persister } = makeSwitchable();
    state.budget = 5;
    await drain(persister, 2);
    await drain(persister, 2);
    await drain(persister, 2);
    expect(debug).toHaveBeenCalledTimes(2);
    expect(String(debug.mock.calls[1][1])).toContain('(4/5 receive generations unsaved)');
    expect(warn).not.toHaveBeenCalled();
    expect(lines.filter((l) => l.includes('Checkpoint skip ON'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('checkpoint persisted'))).toEqual([
      expect.stringContaining('Covers 6 receive generations left by 2 skipped drains.'),
    ]);
    state.budget = 0;
    await drain(persister);
    expect(lines.filter((l) => l.includes('Checkpoint skip OFF'))).toHaveLength(1);
    expect(lines[lines.length - 1]).not.toContain('Covers');
  });

  it('ON: a failed write that covered skipped drains is the one accusing line, and is retried', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    let fail = true;
    const { state, lines, persistCheckpoint, persister } = makeSwitchable(() =>
      fail ? Promise.reject(new Error('disk')) : Promise.resolve()
    );
    state.budget = 100;
    await drain(persister, 2);
    await persister.flush().catch(() => {});
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      'still behind by 2 receive generations of 1 skipped drains'
    );
    expect(lines.some((l) => l.includes('checkpoint failed'))).toBe(false);
    fail = false;
    await persister.flush();
    expect(persistCheckpoint).toHaveBeenCalledTimes(2);
    expect(lines[lines.length - 1]).toContain(
      'Covers 2 receive generations left by 1 skipped drains.'
    );
  });
});

describe('createMlsStatePersister - frames read outside the conversation path', () => {
  const live = { bufferUi: true, showOverlay: false };

  function make(budget: number, persistImpl?: () => Promise<void>) {
    const persistCheckpoint = vi.fn(persistImpl ?? (() => Promise.resolve()));
    const persister = createMlsStatePersister({
      mlsService: { persistCheckpoint } as any,
      receiveSkipBudget: () => budget,
    });
    return { persistCheckpoint, persister };
  }

  it('a structural note (a key-group commit) makes the drain checkpoint instead of skip', async () => {
    const { persistCheckpoint, persister } = make(10);
    persister.onBulkIngestStart();
    persister.noteReceivedFrame(true);
    await persister.onBulkIngestEnd(live);
    await flushMacrotask();
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('counted notes spend the budget: a drain of key-group seeds cannot skip for ever', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { persistCheckpoint, persister } = make(3);
    persister.onBulkIngestStart();
    for (let i = 0; i < 3; i++) persister.noteReceivedFrame(false);
    await persister.onBulkIngestEnd(live);
    await flushMacrotask();
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('notes change nothing while the switch is OFF: no write, no dirty flag', async () => {
    const { persistCheckpoint, persister } = make(0);
    persister.noteReceivedFrame(true);
    persister.noteReceivedFrame(false);
    await flushMacrotask();
    expect(persistCheckpoint).not.toHaveBeenCalled();
    await persister.flush();
    expect(persistCheckpoint).not.toHaveBeenCalled();
  });

  it('ON does not skip while an URGENT checkpoint is in flight, so its failure is retried', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let rejectWrite: (e: Error) => void = () => {};
    let calls = 0;
    const { persistCheckpoint, persister } = make(10, () => {
      calls += 1;
      return calls === 1
        ? new Promise<void>((_, reject) => {
            rejectWrite = reject;
          })
        : Promise.resolve();
    });
    persister.persistNow();
    await flushMacrotask();
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
    // A receive-only drain ends while the urgent write is still running.
    persister.onBulkIngestStart();
    persister.scheduleDeferred();
    await persister.onBulkIngestEnd(live);
    rejectWrite(new Error('disk'));
    await flushMacrotask();
    expect(persistCheckpoint).toHaveBeenCalledTimes(2);
  });
});

describe('persistMlsStructuralCheckpoint and the skip switch', () => {
  const live = { bufferUi: true, showOverlay: false };

  afterEach(() => unregisterMlsStatePersister());

  async function run(budget: number) {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const persistCheckpoint = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('disk')) : Promise.resolve();
    });
    const persister = createMlsStatePersister({
      mlsService: { persistCheckpoint } as any,
      receiveSkipBudget: () => budget,
    });
    registerMlsStatePersister(persister);
    await persistMlsStructuralCheckpoint().catch(() => {});
    // The next live receive-only drain.
    persister.onBulkIngestStart();
    persister.scheduleDeferred();
    await persister.onBulkIngestEnd(live);
    await flushMacrotask();
    return persistCheckpoint;
  }

  it('OFF retries a failed structural checkpoint on the next drain', async () => {
    expect(await run(0)).toHaveBeenCalledTimes(2);
  });

  it('ON retries it too: a structural write that failed is still owed, so the drain never skips', async () => {
    expect(await run(10)).toHaveBeenCalledTimes(2);
  });
});
