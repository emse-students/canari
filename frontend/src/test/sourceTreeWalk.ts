/**
 * The walk behind the shared source snapshot (`sourceTreeSetup.ts` runs it once per run), kept apart
 * from the `globalSetup` entry so a test can run it over a fixture tree.
 *
 * It THROWS rather than return a thin snapshot: several scans have no "is reading the tree it thinks
 * it is" assertion of their own, and a scan over an empty list passes vacuously.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The trees a scan may read, relative to the frontend root. */
export const SNAPSHOT_ROOTS = ['src', 'static'];
/** Text sources only: a scan never reads a binary, and a PNG in a JSON snapshot is dead weight. */
const TEXT = /\.(ts|js|svelte|css|html)$/;

/**
 * Generated output, never part of the snapshot: not in git, rebuilt by `bun run generate` and
 * `bun run paraglide:compile`, 16 MB of it is Paraglide alone. A scan about hand-written source
 * has nothing to say about it.
 */
const GENERATED_DIRS = new Set(['src/lib/paraglide', 'src/lib/wasm']);
const GENERATED_FILES = new Set(['src/lib/proto/canari.js', 'src/lib/proto/canari.d.ts']);

/**
 * The fewest files a healthy snapshot holds. 1,995 were measured on 2026-10-19; the floor is 75 % of
 * that, so a refactor that deletes files does not trip it while a walk that lost a subtree, or ran
 * from the wrong directory, does. Raise it when the tree grows a lot, never lower it to go green.
 */
export const SNAPSHOT_FLOOR = 1500;

function walk(base: string, dir: string, out: Record<string, string>): void {
  for (const entry of readdirSync(join(base, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || GENERATED_DIRS.has(path)) continue;
      walk(base, path, out);
    } else if (TEXT.test(entry.name) && !GENERATED_FILES.has(path)) {
      out[path] = readFileSync(join(base, path), 'utf8');
    }
  }
}

/**
 * Every text source under `roots` of `base`, keyed by POSIX path relative to `base`. Throws when a
 * root is missing, when `src/lib` or `static` is absent from the result, or when fewer than `floor`
 * files were found.
 */
export function snapshotSourceTree(
  base: string,
  options: { roots?: readonly string[]; floor?: number } = {}
): Record<string, string> {
  const roots = options.roots ?? SNAPSHOT_ROOTS;
  const floor = options.floor ?? SNAPSHOT_FLOOR;
  const files: Record<string, string> = {};
  for (const root of roots) walk(base, root, files);
  const paths = Object.keys(files);
  for (const required of ['src/lib/', 'static/']) {
    if (roots.some((r) => required.startsWith(r)) && !paths.some((p) => p.startsWith(required))) {
      throw new Error(
        `[sourceTree] no file under ${required} in ${base}: wrong working directory?`
      );
    }
  }
  if (paths.length < floor) {
    throw new Error(
      `[sourceTree] only ${paths.length} files found under ${roots.join(', ')} in ${base} (floor ${floor}): a scan over a thin snapshot passes vacuously`
    );
  }
  return files;
}
