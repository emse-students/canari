import { describe, expect, it, vi } from 'vitest';
import {
  createDevicePanelLoader,
  panelStateFrom,
  settleRemoval,
  type PanelLoadResult,
} from './devicePanelLoad';

type D = { deviceId: string };
type S = { id: string };

/** A promise the test settles by hand, so two loads can overlap in a chosen order. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('panelStateFrom', () => {
  it('knows the devices only when their fetch answered', () => {
    const ok = panelStateFrom<D, S>({
      devices: { status: 'fulfilled', value: [{ deviceId: 'd1' }] },
      sessions: { status: 'fulfilled', value: [{ id: 's1' }] },
    });
    expect(ok).toMatchObject({ devicesKnown: true, sessionsKnown: true });

    const failed = panelStateFrom<D, S>({
      devices: { status: 'rejected', reason: new Error('down') },
      sessions: { status: 'fulfilled', value: [{ id: 's1' }] },
    });
    expect(failed).toMatchObject({ devices: [], devicesKnown: false, sessionsKnown: true });
  });
});

describe('createDevicePanelLoader', () => {
  /*
   * Two overlapping loads: A starts slow, the panel is reopened and B succeeds, then A rejects. A's
   * answer must write NOTHING - applied, it would leave devices = [] beside B's devicesKnown = true,
   * and every login would become a row that wipes its device.
   */
  it('applies only the latest load: a superseded one that rejects afterwards writes nothing', async () => {
    const a = deferred<D[]>();
    const b = deferred<D[]>();
    const listDevices = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const applied: PanelLoadResult<D, S>[] = [];
    const loader = createDevicePanelLoader<D, S>({
      listDevices,
      fetchSessions: async () => [{ id: 's1' }],
      apply: (r) => applied.push(r),
    });

    const loadA = loader.load();
    const loadB = loader.load();
    b.resolve([{ deviceId: 'phone' }]);
    await loadB;
    a.reject(new Error('timeout'));
    await loadA;

    expect(applied).toHaveLength(1);
    expect(applied[0].devices).toEqual({ status: 'fulfilled', value: [{ deviceId: 'phone' }] });
  });

  it('a superseded load that succeeds late does not overwrite the latest either', async () => {
    const a = deferred<D[]>();
    const listDevices = vi
      .fn()
      .mockReturnValueOnce(a.promise)
      .mockResolvedValueOnce([{ deviceId: 'new' }]);
    const applied: PanelLoadResult<D, S>[] = [];
    const loader = createDevicePanelLoader<D, S>({
      listDevices,
      fetchSessions: async () => [],
      apply: (r) => applied.push(r),
    });
    const loadA = loader.load();
    await loader.load();
    a.resolve([{ deviceId: 'old' }]);
    await loadA;
    expect(applied.map((r) => r.devices)).toEqual([
      { status: 'fulfilled', value: [{ deviceId: 'new' }] },
    ]);
  });
});

describe('settleRemoval', () => {
  /*
   * The panel's reload clears its messages when it starts, so a removal's failure set BEFORE it was
   * wiped before anyone could read it. The message is shown only once the reload has finished.
   */
  it("shows the removal's messages after the reload, which would otherwise clear them", async () => {
    const order: string[] = [];
    let shown = '';
    await settleRemoval({
      remove: async () => {
        order.push('remove');
        return { failure: 'retry', sessionFailure: '' };
      },
      reload: async () => {
        order.push('reload');
        shown = '';
      },
      show: (messages) => {
        order.push('show');
        shown = messages.failure;
      },
    });
    expect(order).toEqual(['remove', 'reload', 'show']);
    expect(shown).toBe('retry');
  });

  it('still reloads and shows nothing when the removal succeeded', async () => {
    const show = vi.fn();
    const reload = vi.fn(async () => undefined);
    await settleRemoval({
      remove: async () => ({ failure: '', sessionFailure: '' }),
      reload,
      show,
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith({ failure: '', sessionFailure: '' });
  });
});
