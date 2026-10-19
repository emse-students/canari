/**
 * The ONE walker of the source tree for tests that scan it ("no file outside X does Y").
 *
 * Nine files carried their own copy of `sourceFiles()`, each re-reading ~2,000 files per test
 * file. They now read a snapshot built once per run by `./sourceTreeSetup.ts` (a vitest
 * `globalSetup`), so a scan is a filter over strings in memory and cannot time out on the disk.
 *
 * The snapshot holds the hand-written `.ts .js .svelte .css .html` under `src` and `static`;
 * generated trees (`src/lib/paraglide`, `src/lib/wasm`, `src/lib/proto/canari.{js,d.ts}`) are NOT
 * in it, and a scan that must see them reads the disk itself. Paths are POSIX, relative to the
 * frontend root (`src/lib/db.ts`).
 *
 * A scan keeps its own "is reading the tree it thinks it is" assertion: this module is the
 * reader, not the proof that it read something.
 */
import { readFileSync } from 'node:fs';

import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Absolute path of the JSON snapshot written by `sourceTreeSetup.ts`. */
    sourceTreeSnapshot: string;
  }
}

/** One file of the snapshot. */
export interface SourceFile {
  /** POSIX path relative to the frontend root, e.g. `src/lib/db.ts`. */
  path: string;
  text: string;
}

/** What a scan wants, spelled out: no scan inherits another's idea of "a source file". */
export interface SourceQuery {
  /** Directories to read, relative to the frontend root: `'src'`, `'src/lib'`, `['src', 'static']`. */
  under: string | readonly string[];
  /** File extensions without the dot, e.g. `['ts', 'svelte']`. */
  extensions: readonly string[];
  /** `exclude`: no `*.test.ts` / `*.spec.ts`; `only`: nothing else; `include`: both. */
  tests: 'exclude' | 'only' | 'include';
  /** Directory NAMES (at any depth) to skip, e.g. `['proto']`. */
  skipDirs?: readonly string[];
}

const TEST_FILE = /\.(test|spec)\.ts$/;

let snapshot: Map<string, string> | undefined;

function load(): Map<string, string> {
  if (!snapshot) {
    const raw = JSON.parse(readFileSync(inject('sourceTreeSnapshot'), 'utf8')) as Record<
      string,
      string
    >;
    snapshot = new Map(Object.entries(raw));
  }
  return snapshot;
}

/** The files of the snapshot matching `query`, in path order. */
export function sourceFiles(query: SourceQuery): SourceFile[] {
  const roots = (typeof query.under === 'string' ? [query.under] : [...query.under]).map(
    (root) => `${root.replace(/\/+$/, '')}/`
  );
  const skip = new Set(query.skipDirs ?? []);
  const out: SourceFile[] = [];
  for (const [path, text] of load()) {
    if (!roots.some((root) => path.startsWith(root))) continue;
    const segments = path.split('/');
    const name = segments[segments.length - 1];
    if (!query.extensions.some((ext) => name.endsWith(`.${ext}`))) continue;
    const isTest = TEST_FILE.test(name);
    if ((query.tests === 'exclude' && isTest) || (query.tests === 'only' && !isTest)) continue;
    if (segments.slice(0, -1).some((dir) => skip.has(dir))) continue;
    out.push({ path, text });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** `path` made relative to `base` (`relativeTo('src/lib/db.ts', 'src')` is `lib/db.ts`). */
export function relativeTo(path: string, base: string): string {
  return path.slice(base.replace(/\/+$/, '').length + 1);
}

/** The text of ONE file of the snapshot, by its frontend-root path; throws when it is not in it. */
export function readSource(path: string): string {
  const text = load().get(path);
  if (text === undefined) throw new Error(`[sourceTree] ${path} is not in the source snapshot`);
  return text;
}
