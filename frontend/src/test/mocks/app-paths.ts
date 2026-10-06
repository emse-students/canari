/**
 * Vitest stub for `$app/paths` (its virtual `__sveltekit/paths` module exists only inside SvelteKit).
 *
 * `resolve` keeps the one behaviour a test can observe: the app is served at the root, so `base` is
 * empty and a path comes back unchanged - and, like the real one, a path that does not start with `/`
 * is refused rather than passed through, so a test cannot bless a call the app would throw on.
 */
export const base = '';

export function resolve(path: string): string {
  if (!path.startsWith('/')) {
    throw new Error(`Cannot use resolve(...) with a non-absolute pathname (got "${path}")`);
  }
  return base + path;
}
