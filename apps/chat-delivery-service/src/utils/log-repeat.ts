/**
 * Says a recurring sentence ONCE per subject, then only at each power of ten of its count.
 *
 * WHY: a line that fires on nearly every operation is reporting a RATE, and a rate is not read one
 * line at a time (durable-rules, "A LINE THAT FIRES ON NEARLY EVERY OPERATION..."). The first
 * occurrence carries the whole sentence; the 10th, 100th, 1000th carry the count, so a subject
 * whose number keeps growing still shows, and a reader is never handed the same line per send.
 * No clock decides anything here - only the count does.
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

/**
 * Cuts an identifier to what a log needs: enough to correlate two lines, nothing that names a
 * person in full. Device ids keep 12 characters so their `web-`/`ios-`/`tauri-` prefix survives -
 * the cross-client rig's classifier keys on it.
 */
export const cutUserId = (id: string | null | undefined): string => String(id ?? '').slice(0, 8);
/** See {@link cutUserId}. */
export const cutDeviceId = (id: string | null | undefined): string => String(id ?? '').slice(0, 12);
