/**
 * What a recurring decision line says: the whole decision ONCE, then only a count of its repeats.
 *
 * WHY NOT SIMPLY ONCE (review of #2718, 2026-10-30): a repeat of the same decision is still evidence
 * - an asker that keeps asking against an unchanged state is the defect to see - and a line said only
 * once hides how often. WHY NOT EVERY TIME: the same sentence per ask is a rate read one line at a
 * time. So a changed decision is said in full, and a repeat of the same one at its 1st, 10th, 100th...
 * occurrence, as the delivery service's `RepeatCounter` does (`apps/chat-delivery-service/src/utils/
 * log-repeat.ts`). No clock decides anything; only the facts in `decision` and the count do.
 *
 * Bounded by `maxSlots`: past it the oldest slot is forgotten, which can only cost one repeated full
 * line, never a missing one.
 */
export class DecisionLog {
  private readonly slots = new Map<string, { decision: string; repeats: number }>();

  constructor(private readonly maxSlots: number) {}

  /**
   * Notes `decision` for `slot`.
   *
   * @returns `{ say: 'decision' }` when it is new for the slot (say the full line), `{ say: 'repeat',
   *   nth }` at the 1st, 10th, 100th... repeat of the same decision (say the count), otherwise null.
   */
  note(
    slot: string,
    decision: string
  ): { say: 'decision' } | { say: 'repeat'; nth: number } | null {
    const last = this.slots.get(slot);
    if (last?.decision === decision) {
      last.repeats += 1;
      return isPowerOfTen(last.repeats) ? { say: 'repeat', nth: last.repeats } : null;
    }
    if (!last && this.slots.size >= this.maxSlots) {
      const oldest = this.slots.keys().next().value;
      if (oldest !== undefined) this.slots.delete(oldest);
    }
    this.slots.set(slot, { decision, repeats: 0 });
    return { say: 'decision' };
  }

  /** Forgets one slot: its next decision is said in full, whatever it is. */
  forget(slot: string): void {
    this.slots.delete(slot);
  }

  /** Forgets every slot (sign-out, tests). */
  reset(): void {
    this.slots.clear();
  }

  /** How many slots are held - for the bound's test. */
  get size(): number {
    return this.slots.size;
  }
}

/** True for 1, 10, 100, ... */
function isPowerOfTen(n: number): boolean {
  let x = n;
  while (x >= 10 && x % 10 === 0) x /= 10;
  return x === 1;
}
