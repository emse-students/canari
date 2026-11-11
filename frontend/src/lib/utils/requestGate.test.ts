import { RequestGate } from './requestGate';

/**
 * WHAT THE CAP HAS TO GUARANTEE, and nothing about timing.
 *
 * The defect it exists for is sixty full-size media downloads issued in one frame - when
 * "Medias, liens & fichiers" mounts its window of 60, and when a chat scroll steps the render
 * window by 140 groups. The properties that matter are therefore countable: never more than the
 * limit at once, every task eventually runs, a slot is released even when a task throws, and a
 * task abandoned while WAITING never starts at all - which is the whole point for a reader
 * scrolling past thirty rows.
 */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('RequestGate', () => {
  it('never runs more than the limit at once', async () => {
    const gate = new RequestGate(3);
    const gates = Array.from({ length: 10 }, () => deferred());
    let started = 0;
    let peak = 0;

    const runs = gates.map((d) =>
      gate.run(async () => {
        started++;
        peak = Math.max(peak, gate.inFlight);
        await d.promise;
      })
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(3);
    expect(gate.queued).toBe(7);

    for (const d of gates) d.resolve();
    await Promise.all(runs);
    expect(started).toBe(10);
    expect(peak).toBeLessThanOrEqual(3);
    expect(gate.inFlight).toBe(0);
  });

  it('hands the slot on in the order it was asked for', async () => {
    const gate = new RequestGate(1);
    const order: number[] = [];
    const first = deferred();
    const runs = [
      gate.run(async () => {
        order.push(0);
        await first.promise;
      }),
      gate.run(async () => void order.push(1)),
      gate.run(async () => void order.push(2)),
    ];
    first.resolve();
    await Promise.all(runs);
    expect(order).toEqual([0, 1, 2]);
  });

  it('releases the slot when a task throws, rather than wedging the queue', async () => {
    const gate = new RequestGate(1);
    await expect(
      gate.run(async () => {
        throw new Error('media download failed: 500');
      })
    ).rejects.toThrow('500');
    expect(gate.inFlight).toBe(0);
    await expect(gate.run(async () => 'next')).resolves.toBe('next');
  });

  it('never starts a task abandoned while it was waiting', async () => {
    const gate = new RequestGate(1);
    const holding = deferred();
    const held = gate.run(() => holding.promise);

    const abort = new AbortController();
    let ran = false;
    const queued = gate.run(async () => {
      ran = true;
    }, abort.signal);

    abort.abort();
    await expect(queued).rejects.toBeDefined();
    expect(gate.queued).toBe(0);

    holding.resolve();
    await held;
    expect(ran).toBe(false);
  });

  it('refuses an already-aborted task without taking a slot', async () => {
    const gate = new RequestGate(2);
    const abort = new AbortController();
    abort.abort();
    let ran = false;
    await expect(
      gate.run(async () => {
        ran = true;
      }, abort.signal)
    ).rejects.toBeDefined();
    expect(ran).toBe(false);
    expect(gate.inFlight).toBe(0);
  });

  it('lets an abandoned waiter pass its place to the next in line', async () => {
    const gate = new RequestGate(1);
    const holding = deferred();
    const held = gate.run(() => holding.promise);

    const abort = new AbortController();
    const abandoned = gate.run(async () => 'never', abort.signal);
    const after = gate.run(async () => 'ran');

    abort.abort();
    await expect(abandoned).rejects.toBeDefined();
    holding.resolve();
    await held;
    await expect(after).resolves.toBe('ran');
  });
});

/**
 * THE BACKGROUND LANE (owner, 2026-11-11: the reel viewer fetches the next pages in parallel). What
 * it must guarantee: bytes fetched ahead never take the last free slot, and every foreground task
 * - what is on screen - goes before every background one.
 */
describe('RequestGate background lane', () => {
  it('never lets background tasks fill the gate: one slot stays free for the foreground', async () => {
    const gate = new RequestGate(3);
    const holds = Array.from({ length: 5 }, () => deferred());
    let running = 0;
    const runs = holds.map((d) =>
      gate.run(
        async () => {
          running++;
          await d.promise;
          running--;
        },
        undefined,
        'background'
      )
    );
    await Promise.resolve();
    expect(running).toBe(2);
    expect(gate.queued).toBe(3);

    // A foreground task finds the free slot at once.
    let fg = false;
    const front = gate.run(async () => void (fg = true));
    await Promise.resolve();
    expect(fg).toBe(true);
    await front;

    for (const d of holds) d.resolve();
    await Promise.all(runs);
    expect(gate.inFlight).toBe(0);
  });

  it('hands a freed slot to a waiting foreground task before any background one', async () => {
    const gate = new RequestGate(2);
    const order: string[] = [];
    const a = deferred();
    const b = deferred();
    const busy = [gate.run(() => a.promise), gate.run(() => b.promise)];
    const bg = gate.run(async () => void order.push('bg'), undefined, 'background');
    const fg = gate.run(async () => void order.push('fg'));
    a.resolve();
    await fg;
    expect(order).toEqual(['fg']);
    b.resolve();
    await Promise.all([...busy, bg]);
    expect(order).toEqual(['fg', 'bg']);
  });

  it('a background task abandoned while queued never starts', async () => {
    const gate = new RequestGate(3);
    const hold = deferred();
    const fg = [gate.run(() => hold.promise), gate.run(() => hold.promise)];
    const abort = new AbortController();
    let started = false;
    const bg = gate.run(async () => void (started = true), abort.signal, 'background');
    expect(gate.queued).toBe(1);
    abort.abort(new DOMException('passed', 'AbortError'));
    await expect(bg).rejects.toThrow('passed');
    expect(gate.queued).toBe(0);
    hold.resolve();
    await Promise.all(fg);
    expect(started).toBe(false);
  });
});
