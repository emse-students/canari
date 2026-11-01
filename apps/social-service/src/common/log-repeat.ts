/**
 * Says a recurring sentence ONCE per subject, then only at each power of ten of its count.
 *
 * Social-service's copy of chat-delivery's `RepeatCounter` (`utils/log-repeat.ts` there - the two
 * services share no package). WHY: a line that can fire on every request is reporting a RATE, and a
 * rate is not read one line at a time. The first occurrence carries the whole sentence; the 10th,
 * 100th, 1000th carry the count. No clock decides anything - only the count does.
 *
 * The map is per process and bounded by `maxSubjects`: past it the oldest subject is forgotten and,
 * if it recurs, simply says its sentence again - the conservative direction.
 */
export class RepeatCounter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly maxSubjects = 5000) {}

  /**
   * Counts one occurrence for `subject`.
   *
   * @returns the occurrence's ordinal when it should be printed (1, 10, 100, ...), otherwise null.
   */
  hit(subject: string): number | null {
    const n = (this.counts.get(subject) ?? 0) + 1;
    if (!this.counts.has(subject) && this.counts.size >= this.maxSubjects) {
      const oldest = this.counts.keys().next().value;
      if (oldest !== undefined) this.counts.delete(oldest);
    }
    this.counts.set(subject, n);
    return isPowerOfTen(n) ? n : null;
  }
}

/** True for 1, 10, 100, ... */
function isPowerOfTen(n: number): boolean {
  let x = n;
  while (x >= 10 && x % 10 === 0) x /= 10;
  return x === 1;
}
