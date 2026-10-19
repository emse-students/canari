/**
 * Vitest `globalSetup`: walk the source tree ONCE per run and hand every test file the same
 * snapshot, instead of letting ~20 source-scan files each walk and re-read it.
 *
 * Vitest isolates modules per test file, so a memo inside a helper is rebuilt by every file; and
 * under full-suite load those walks (5,000 `readdir`/`stat`/`read` calls on Windows) were what
 * pushed the first test of a scan file past the 5 s timeout. The snapshot goes to ONE file under
 * `node_modules/.cache` and only its path is `provide`d: `provide` is serialised to EVERY worker
 * for EVERY file (~940), so the 15 MB of text must not ride on it.
 *
 * Fresh per run, deleted at teardown, so it cannot be stale. Watch mode builds it once at start:
 * an edit made during `vitest` watch is not seen by a scan until the process is restarted, which
 * is the price of one walk (the scans are CI guards, not an inner-loop tool). Reader:
 * `./sourceTree.ts`, and docs/wiki/test-suite-reform.md (WP-T9).
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TestProject } from 'vitest/node';

/** The trees a scan may read, relative to the frontend root. */
const ROOTS = ['src', 'static'];
/** Text sources only: a scan never reads a binary, and a PNG in a JSON snapshot is dead weight. */
const TEXT = /\.(ts|js|svelte|css|html)$/;

/**
 * Generated output, never part of the snapshot: not in git, rebuilt by `bun run generate` and
 * `bun run paraglide:compile`, 16 MB of it is Paraglide alone. A scan about hand-written source
 * has nothing to say about it.
 */
const GENERATED_DIRS = new Set(['src/lib/paraglide', 'src/lib/wasm']);
const GENERATED_FILES = new Set(['src/lib/proto/canari.js', 'src/lib/proto/canari.d.ts']);

function walk(dir: string, out: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || GENERATED_DIRS.has(path)) continue;
      walk(path, out);
    } else if (TEXT.test(entry.name) && !GENERATED_FILES.has(path)) {
      out[path] = readFileSync(path, 'utf8');
    }
  }
}

export default function setup(project: TestProject): () => void {
  const files: Record<string, string> = {};
  for (const root of ROOTS) walk(root, files);

  const dir = join('node_modules', '.cache', 'canari-source-tree');
  mkdirSync(dir, { recursive: true });
  const snapshot = join(process.cwd(), dir, `snapshot-${process.pid}.json`);
  writeFileSync(snapshot, JSON.stringify(files));
  project.provide('sourceTreeSnapshot', snapshot);
  console.debug(`[sourceTree] ${Object.keys(files).length} files snapshotted for the scans`);

  return () => rmSync(snapshot, { force: true });
}
