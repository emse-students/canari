/**
 * A MEMBER LIST IN FAMILY-NAME ORDER THAT NEVER MOVES A ROW BECAUSE A NAME ARRIVED.
 *
 * The profile fetch is mocked with promises the test settles by hand, so each assertion reads the
 * list at a moment the panel would actually render: nothing settled, some settled, a late answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync } from 'svelte';

type Parts = { firstName: string | null; lastName: string | null; displayName: string | null };
const fetchUserProfile = vi.fn<(id: string) => Promise<Parts>>();

vi.mock('$lib/stores/user', () => ({
  fetchUserProfile: (id: string) => fetchUserProfile(id),
}));

const { membersByFamilyName } = await import('./memberOrder.svelte');

/** A profile promise the test resolves or rejects when it chooses. */
function deferred() {
  let resolve!: (parts: Parts) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<Parts>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const person = (firstName: string, lastName: string): Parts => ({
  firstName,
  lastName,
  displayName: `${firstName} ${lastName}`,
});

/** Lets every `.then` chain of a settled profile run, then flushes the effects it fed. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  flushSync();
}

let stop: (() => void) | undefined;

beforeEach(() => {
  fetchUserProfile.mockReset();
});

afterEach(() => {
  stop?.();
  stop = undefined;
});

describe('membersByFamilyName', () => {
  it('lists nobody until a lookup settles, then lists by family name', async () => {
    const profiles: Record<string, Parts> = {
      hugo: person('Hugo', 'VIENNE'),
      maxime: person('Maxime', 'BASEL'),
      melvin: person('Melvin', 'BRETON--DESCHAMPS'),
    };
    fetchUserProfile.mockImplementation((id) => Promise.resolve(profiles[id]));
    let order!: { current: string[]; pending: number };
    stop = $effect.root(() => {
      order = membersByFamilyName(() => ['hugo', 'maxime', 'melvin']);
    });
    flushSync();
    expect(order.current).toEqual([]);
    expect(order.pending).toBe(3);

    await settle();
    expect(order.current).toEqual(['maxime', 'melvin', 'hugo']);
    expect(order.pending).toBe(0);
  });

  it('puts a member whose lookup failed last, and freezes that key while they stay listed', async () => {
    const late = deferred();
    fetchUserProfile.mockImplementation((id) =>
      id === 'ghost' ? Promise.reject(new Error('offline')) : Promise.resolve(person('Zoe', 'Zola'))
    );
    let ids = $state(['ghost', 'zoe']);
    let order!: { current: string[] };
    stop = $effect.root(() => {
      order = membersByFamilyName(() => ids);
    });
    flushSync();
    await settle();
    expect(order.current).toEqual(['zoe', 'ghost']);

    // A later list change re-runs the effect; the frozen key is not asked for again.
    fetchUserProfile.mockImplementation(() => late.promise);
    ids = ['ghost', 'zoe', 'abel'];
    flushSync();
    expect(fetchUserProfile.mock.calls.map((c) => c[0])).toEqual(['ghost', 'zoe', 'abel']);
    late.resolve(person('Anne', 'Abel'));
    await settle();
    // The newcomer takes its place; the rows already there keep their relative order.
    expect(order.current).toEqual(['abel', 'zoe', 'ghost']);
  });

  it('drops an id that leaves the list, and an answer landing for it afterwards writes nothing', async () => {
    const slow = deferred();
    fetchUserProfile.mockImplementation((id) =>
      id === 'gone' ? slow.promise : Promise.resolve(person('Anne', 'Abel'))
    );
    let ids = $state(['gone', 'abel']);
    let order!: { current: string[]; pending: number };
    stop = $effect.root(() => {
      order = membersByFamilyName(() => ids);
    });
    flushSync();
    await settle();
    expect(order.current).toEqual(['abel']);
    expect(order.pending).toBe(1);

    ids = ['abel'];
    flushSync();
    slow.resolve(person('Gaston', 'Aaron'));
    await settle();
    expect(order.current).toEqual(['abel']);
    expect(order.pending).toBe(0);
  });

  it('asks for each profile under its normalised id', () => {
    fetchUserProfile.mockImplementation(() => new Promise(() => {}));
    stop = $effect.root(() => {
      membersByFamilyName(() => [' MixedCase ']);
    });
    flushSync();
    expect(fetchUserProfile).toHaveBeenCalledWith('mixedcase');
  });
});
