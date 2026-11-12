/**
 * A predicate that answers `true` the FIRST time it sees a key, and `false` ever after.
 *
 * For an accusing log line written from a recomputing context (a `$derived`, an effect): the line
 * is owed once per key, not once per recompute. The memory is deliberately NOT reactive - nothing
 * draws from it, and a reactive set mutated inside a `$derived` is a Svelte runtime error - so it
 * lives here, outside the component, rather than as a `Set` that the reactivity lint (rightly)
 * questions in a `.svelte` file.
 */
export function createFirstSighting(): (key: string) => boolean {
  const seen = new Set<string>();
  return (key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}
