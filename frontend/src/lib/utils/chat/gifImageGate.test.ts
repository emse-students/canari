import { describe, expect, it } from 'vitest';
import { createImageGate } from './gifImageGate';

const settled = () => new Promise((r) => setTimeout(r, 0));

describe('createImageGate', () => {
  it('lets `limit` downloads run and queues the rest in asking order', async () => {
    const gate = createImageGate(2);
    const order: number[] = [];
    const tickets = [0, 1, 2, 3].map((i) => {
      const t = gate.acquire();
      void t.granted.then(() => order.push(i));
      return t;
    });
    await settled();
    expect(order).toEqual([0, 1]);
    expect(gate.active).toBe(2);

    tickets[0].release();
    await settled();
    expect(order).toEqual([0, 1, 2]);
    tickets[1].release();
    await settled();
    expect(order).toEqual([0, 1, 2, 3]);
    expect(gate.active).toBe(2);
  });

  it('releases once: a second release does not free a slot it never held', async () => {
    const gate = createImageGate(1);
    const a = gate.acquire();
    const b = gate.acquire();
    await settled();
    a.release();
    a.release();
    await settled();
    expect(gate.active).toBe(1);
    b.release();
    expect(gate.active).toBe(0);
  });

  it('a tile that leaves the queue before its turn never takes a slot', async () => {
    const gate = createImageGate(1);
    const a = gate.acquire();
    const gone = gate.acquire();
    let reached = false;
    void gone.granted.then(() => (reached = true));
    const c = gate.acquire();
    let cGranted = false;
    void c.granted.then(() => (cGranted = true));
    gone.release();
    a.release();
    await settled();
    expect(reached).toBe(false);
    expect(cGranted).toBe(true);
    expect(gate.active).toBe(1);
  });
});
