/**
 * THE ONE HANDLE ON A SCROLL RESTORE STILL RUNNING (`scrollMemory.ts`), in its own module so that
 * `scrollToTop.ts` can end a restore without importing the module that imports IT (a cycle).
 *
 * A restore that keeps aligning a post must never fight another programmatic scroll: a tap on the
 * active tab (`scrollPageToTop`) or a change of feed tab (`resetPageScroll`) ends it first.
 */
let stopRestore: (() => void) | null = null;

/** Registers the restore now running; the previous one, if any, was already ended by its caller. */
export function setActiveRestore(stop: (() => void) | null): void {
  stopRestore = stop;
}

/** Whether `stop` is the restore running. */
export function isActiveRestore(stop: () => void): boolean {
  return stopRestore === stop;
}

/** Ends a restore still waiting or following: a navigation or another programmatic scroll begins. */
export function cancelRestore(): void {
  stopRestore?.();
  stopRestore = null;
}
