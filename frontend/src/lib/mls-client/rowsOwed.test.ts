/**
 * ROWS BEFORE RATCHET, THE DECRYPT HALF: the ledger a checkpoint holds before it exports. A hold
 * closes the gate (no new mark), and resolves once every mark taken before it settled; a decrypt
 * that has not marked waits at the closed gate. Every order here is decided by the test, never by
 * a clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RowsOwedLedger } from './rowsOwed';

/** Lets every pending continuation run, so "still pending" below means blocked, not slow. */
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('RowsOwedLedger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('takes a mark at once while no checkpoint holds it, and a hold with no mark resolves at once', async () => {
    const ledger = new RowsOwedLedger();
    const settleRow = await ledger.owe();
    expect(ledger.owedCount).toBe(1);
    settleRow();
    expect(ledger.owedCount).toBe(0);
    const release = await ledger.hold();
    release();
  });

  it('a hold waits for every mark taken before it, and only those', async () => {
    const ledger = new RowsOwedLedger();
    const first = await ledger.owe();
    const second = await ledger.owe();
    let held = false;
    const hold = ledger.hold().then((release) => {
      held = true;
      return release;
    });
    await settle();
    expect(held).toBe(false);
    first();
    await settle();
    expect(held).toBe(false);
    second();
    await settle();
    expect(held).toBe(true);
    (await hold)();
  });

  it('a decrypt that asks while a checkpoint holds waits until the release - it never decrypts under the export', async () => {
    const ledger = new RowsOwedLedger();
    const release = await ledger.hold();
    let marked = false;
    const mark = ledger.owe().then((settleRow) => {
      marked = true;
      return settleRow;
    });
    await settle();
    expect(marked).toBe(false);
    expect(ledger.owedCount).toBe(0);
    release();
    await settle();
    expect(marked).toBe(true);
    expect(ledger.owedCount).toBe(1);
    (await mark)();
  });

  it('the gate opens only when the LAST of two holds is released', async () => {
    const ledger = new RowsOwedLedger();
    const a = await ledger.hold();
    const b = await ledger.hold();
    let marked = false;
    void ledger.owe().then(() => {
      marked = true;
    });
    a();
    await settle();
    expect(marked).toBe(false);
    b();
    await settle();
    expect(marked).toBe(true);
  });

  it('a waiter woken by a release re-reads the gate: a hold taken before its turn keeps it out', async () => {
    const ledger = new RowsOwedLedger();
    const first = await ledger.hold();
    let marked = false;
    void ledger.owe().then(() => {
      marked = true;
    });
    await settle();
    // Released, and closed again in the same turn - before the woken waiter runs.
    first();
    const second = await ledger.hold();
    await settle();
    expect(marked).toBe(false);
    expect(ledger.owedCount).toBe(0);
    second();
    await settle();
    expect(marked).toBe(true);
  });

  it('settling or releasing twice counts once', async () => {
    const ledger = new RowsOwedLedger();
    const one = await ledger.owe();
    const two = await ledger.owe();
    one();
    one();
    expect(ledger.owedCount).toBe(1);
    let held = false;
    const hold = ledger.hold().then((release) => {
      held = true;
      return release;
    });
    await settle();
    expect(held).toBe(false);
    two();
    const release = await hold;
    release();
    release();
    // Released once: a second release must not reopen a gate another hold closed.
    const other = await ledger.hold();
    let marked = false;
    void ledger.owe().then(() => {
      marked = true;
    });
    await settle();
    expect(marked).toBe(false);
    other();
    await settle();
    expect(marked).toBe(true);
  });
});
