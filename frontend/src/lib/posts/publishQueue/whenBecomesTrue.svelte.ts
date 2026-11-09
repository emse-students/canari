/**
 * Runs `onTrue` each time the reactive `read` CHANGES to true - once when it already is - and
 * never when what it reads from is merely reassigned with the same answer.
 *
 * The publish queue's wake on `/api/version`'s `publishQueue` (`publishQueue.svelte.ts`): that answer
 * is a `$state` object reassigned at every focus, so an effect reading it directly fired a pass at
 * every focus (review of #3061). Through a `$derived`, the effect depends on the boolean alone.
 *
 * @returns the teardown (sign-out).
 */
export function whenBecomesTrue(read: () => boolean, onTrue: () => void): () => void {
  return $effect.root(() => {
    const value = $derived(read());
    $effect(() => {
      if (value) onTrue();
    });
  });
}
