import { createMlsStatePersister } from './mlsStatePersister';
import {
  registerMlsStatePersister,
  unregisterMlsStatePersister,
  scheduleOutboundMlsPersist,
  persistMlsStructuralCheckpoint,
} from './mlsStatePersisterRegistry';

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
    await new Promise((r) => setTimeout(r, 50));
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
    await new Promise((r) => setTimeout(r, 50));
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
    await new Promise((r) => setTimeout(r, 50));

    // The window is closed while the disk write is still in flight - that is the whole point.
    expect(ended).toBe(true);
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);

    release();
    await new Promise((r) => setTimeout(r, 50));
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
    await new Promise((r) => setTimeout(r, 50));
  });

  // The 50 ms wait IS the finding, so it is named rather than tolerated: the write is queued on a
  // microtask and the call returns `void`, so no caller can await it and none does. This shortens
  // the window in which a reload would restore a ratchet behind the frames already sent; what
  // CLOSES that window is the send ledger, asserted in `BaseMlsService.sendSeam.test.ts`.
  it('scheduleOutboundMlsPersist reaches disk EVENTUALLY, on a microtask nobody awaits', async () => {
    const { persistCheckpoint, persister } = makePersister();
    registerMlsStatePersister(persister);
    expect(scheduleOutboundMlsPersist()).toBeUndefined();
    expect(persistCheckpoint).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 50));
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of outbound sends into one checkpoint', async () => {
    const { persistCheckpoint, persister } = makePersister();
    registerMlsStatePersister(persister);
    scheduleOutboundMlsPersist();
    scheduleOutboundMlsPersist();
    scheduleOutboundMlsPersist();
    await new Promise((r) => setTimeout(r, 50));
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('outbound sends during a bulk ingest wait for the ingest to end', async () => {
    const { persistCheckpoint, persister } = makePersister();
    registerMlsStatePersister(persister);
    persister.onBulkIngestStart();
    scheduleOutboundMlsPersist();
    await new Promise((r) => setTimeout(r, 50));
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
          await new Promise((r) => setTimeout(r, 0));
        },
      };
    }

    it('resolves only once a checkpoint that exported AFTER the change is written', async () => {
      const c = controlled();
      c.persister.scheduleDeferred();
      void c.persister.flush(); // checkpoint A exports version 1
      await new Promise((r) => setTimeout(r, 0));

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
      await new Promise((r) => setTimeout(r, 0));

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
      await new Promise((r) => setTimeout(r, 0));

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
