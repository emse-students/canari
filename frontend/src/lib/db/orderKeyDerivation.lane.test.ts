/**
 * The ONE lane every order-key derivation runs on (`OrderKeyDerivations`), and who goes first on it.
 *
 * Third review of #2824, finding 2: on the first boot after the update every conversation the boot
 * opened queues a background run, and a reader scrolling up in ONE conversation waited behind all
 * of them. A run someone waits for now starts before every background run still queued - still one
 * at a time, a run in progress never preempted.
 */
import {
  OrderKeyDerivations,
  type OrderKeyDerivation,
  type OrderKeyRunPriority,
} from './orderKeyDerivation';

const NOTHING: OrderKeyDerivation = { derived: 0, unreadable: 0, deferred: 0 };

/** Lets every queued microtask and promise callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A lane plus a log of the order runs STARTED in, each run held until the case releases it. */
function lane() {
  const derivations = new OrderKeyDerivations();
  const started: string[] = [];
  const releases = new Map<string, (done: OrderKeyDerivation) => void>();
  const startOf = (conversationId: string) =>
    vi.fn(() => {
      started.push(conversationId);
      return new Promise<OrderKeyDerivation>((resolve) => releases.set(conversationId, resolve));
    });
  const queue = (conversationId: string, priority: OrderKeyRunPriority) => {
    const start = startOf(conversationId);
    const run =
      priority === 'background'
        ? (derivations.startInBackground(conversationId, start), undefined)
        : derivations.run(conversationId, start);
    return { start, run };
  };
  const release = async (conversationId: string, done: OrderKeyDerivation = NOTHING) => {
    releases.get(conversationId)!(done);
    await settle();
  };
  return { derivations, started, queue, release };
}

describe('the order-key lane', () => {
  it('starts a run a reader waits for before the background runs queued ahead of it', async () => {
    const { started, queue, release } = lane();
    queue('a', 'background');
    queue('b', 'background');
    queue('c', 'background');
    const { run } = queue('reader', 'waited');
    await settle();
    // `a` holds the lane and is not preempted.
    expect(started).toEqual(['a']);

    await release('a');
    expect(started).toEqual(['a', 'reader']);
    await release('reader');
    await expect(run).resolves.toEqual(NOTHING);
    await release('b');
    await release('c');
    // Every background run still ran, one at a time, in the order queued.
    expect(started).toEqual(['a', 'reader', 'b', 'c']);
  });

  it('promotes a background run of the same conversation instead of starting a second one', async () => {
    const { derivations, started, queue, release } = lane();
    queue('a', 'background');
    queue('b', 'background');
    const background = queue('reader', 'background');
    const waitedStart = vi.fn(async () => NOTHING);
    const waited = derivations.run('reader', waitedStart);
    await settle();

    await release('a');
    expect(started).toEqual(['a', 'reader']);
    await release('reader', { derived: 3, unreadable: 0, deferred: 0 });
    // ONE run: the waiter joined the queued one, whose result it receives.
    await expect(waited).resolves.toEqual({ derived: 3, unreadable: 0, deferred: 0 });
    expect(background.start).toHaveBeenCalledTimes(1);
    expect(waitedStart).not.toHaveBeenCalled();
    await release('b');
    expect(started).toEqual(['a', 'reader', 'b']);
  });

  it('waited runs keep their own order among themselves', async () => {
    const { started, queue, release } = lane();
    queue('a', 'background');
    queue('bg', 'background');
    queue('first', 'waited');
    queue('second', 'waited');
    await settle();
    await release('a');
    await release('first');
    await release('second');
    await release('bg');
    expect(started).toEqual(['a', 'first', 'second', 'bg']);
  });

  it('a run that throws releases the lane for the next one', async () => {
    const { derivations, started, queue, release } = lane();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    derivations.startInBackground('broken', () => {
      throw new Error('store gone');
    });
    queue('after', 'background');
    await settle();
    expect(started).toEqual(['after']);
    await release('after');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('order-key derivation of broken'));
    error.mockRestore();
  });
});

describe('a conversation whose run deferred a row', () => {
  it('is re-armed by a page read that decrypted a row still pending, and derived again behind it', async () => {
    const derivations = new OrderKeyDerivations();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await derivations.run('conv', async () => ({ derived: 0, unreadable: 0, deferred: 2 }));
    warn.mockRestore();
    expect(derivations.gaveUp('conv')).toBe(true);

    const page = [
      { pageKey: { orderAt: 1, id: 'x', provisional: false } },
      { pageKey: { orderAt: 2, id: 'y', provisional: false } },
    ];
    const again = vi.fn(async () => ({ derived: 2, unreadable: 0, deferred: 0 }));
    derivations.readableAgain('conv', page, again);

    expect(derivations.gaveUp('conv')).toBe(false);
    // The page's boundary is provisional again: the next load-older waits for the keys.
    expect(page.every((row) => row.pageKey.provisional)).toBe(true);
    await settle();
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('a re-arm landing right after the run settled starts a NEW run, never joins the settled one (review 4 of #2824)', async () => {
    const derivations = new OrderKeyDerivations();
    const again = vi.fn(async () => ({ derived: 2, unreadable: 0, deferred: 0 }));
    const page = [{ pageKey: { orderAt: 1, id: 'x', provisional: false } }];
    // The warning is written inside the callback that records the deferral; a microtask queued
    // there runs once that callback has returned and BEFORE any reaction chained on its result -
    // the window in which a `.finally` used to still hold the settled run in `inFlight`.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      queueMicrotask(() => derivations.readableAgain('conv', page, again));
    });
    await derivations.run('conv', async () => ({ derived: 0, unreadable: 0, deferred: 2 }));
    warn.mockRestore();
    await settle();

    expect(derivations.gaveUp('conv')).toBe(false);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('is left alone by a page read in a conversation that deferred nothing', async () => {
    const derivations = new OrderKeyDerivations();
    const page = [{ pageKey: { orderAt: 1, id: 'x', provisional: false } }];
    const again = vi.fn(async () => NOTHING);
    derivations.readableAgain('conv', page, again);
    await settle();
    expect(page[0].pageKey.provisional).toBe(false);
    expect(again).not.toHaveBeenCalled();
  });
});
