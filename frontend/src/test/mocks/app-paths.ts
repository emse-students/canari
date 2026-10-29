/**
 * Vitest stub for `$app/paths` (its virtual `__sveltekit/paths` module exists only inside SvelteKit).
 *
 * `resolve` follows SvelteKit 3's two forms: a string starting with `/` is a ROUTE ID and a string
 * that does not is a PATHNAME, which gains its leading slash. The app is served at the root, so the
 * base is empty and both come back as an absolute path.
 */
export function resolve(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/** Matches nothing: a unit test has no route table. */
export async function match(_url: string | URL): Promise<null> {
  return null;
}
