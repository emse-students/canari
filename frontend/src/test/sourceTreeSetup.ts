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
 * Fresh per run, deleted at teardown, so it cannot be stale. A run that was killed leaves its file
 * behind, so setup deletes snapshots older than a day (never a younger one: a concurrent run in the
 * same checkout owns it). Watch mode builds it once at start: an edit made during `vitest` watch is
 * not seen by a scan until the process is restarted, which is the price of one walk (the scans are
 * CI guards, not an inner-loop tool). The walk and its floor: `./sourceTreeWalk.ts`; reader:
 * `./sourceTree.ts`; docs/wiki/test-suite-reform.md (WP-T9).
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TestProject } from 'vitest/node';

import { snapshotSourceTree } from './sourceTreeWalk';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export default function setup(project: TestProject): () => void {
  const files = snapshotSourceTree(process.cwd());

  const dir = join(process.cwd(), 'node_modules', '.cache', 'canari-source-tree');
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (!/^snapshot-\d+\.json$/.test(name)) continue;
    const old = join(dir, name);
    if (Date.now() - statSync(old).mtimeMs > STALE_AFTER_MS) {
      console.debug(`[sourceTree] removing stale ${name} (a killed run)`);
      rmSync(old, { force: true });
    }
  }
  const snapshot = join(dir, `snapshot-${process.pid}.json`);
  writeFileSync(snapshot, JSON.stringify(files));
  project.provide('sourceTreeSnapshot', snapshot);
  console.debug(`[sourceTree] ${Object.keys(files).length} files snapshotted for the scans`);

  return () => rmSync(snapshot, { force: true });
}
