import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A SHARE THAT KEPT NO FILE LEAVES NO FOLDER IN `cache/shared_inbox/` (Mi 9T, 2026-10-27).
 *
 * `IncomingShare.runCapture` makes the share's folder before copying its streams. A share with text
 * and no file kept that empty folder: no manifest entry names it, so neither the page (which
 * deletes a file it takes or drops) nor a later capture ever touched it, and one accumulated per
 * text share until the next process start. The folder now goes as soon as the copy loop kept
 * nothing, text or not; what older builds left goes with the per-process sweep.
 *
 * WHY A SOURCE GUARD. `IncomingShare.kt` imports Android, so the JVM suite (`android-tests`) cannot
 * compile it, and the folder is only observable on a device - which is where this was read.
 */
const here = dirname(fileURLToPath(import.meta.url));
const JAVA = resolve(here, '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari');
const capture = readFileSync(resolve(JAVA, 'IncomingShare.kt'), 'utf8');
const activity = readFileSync(resolve(JAVA, 'MainActivity.kt'), 'utf8');

/** `runCapture`, from its declaration to the manifest it hands over. */
function runCapture(): string {
  const start = capture.indexOf('private fun runCapture(');
  expect(start).toBeGreaterThan(-1);
  const end = capture.indexOf('writePending(context, payload)', start);
  expect(end).toBeGreaterThan(start);
  return capture.slice(start, end);
}

describe('the Android share inbox', () => {
  it('deletes the folder of a share that kept no file, whatever its text', () => {
    // Keyed on the file count ALONE: the old guard also required an empty text, so a text share
    // kept its folder.
    expect(runCapture()).toMatch(/if \(files\.length\(\) == 0\) \{\s*deleteDir\(dir,/);
  });

  it('still sweeps what an earlier process left, from the first onCreate', () => {
    expect(activity).toMatch(/IncomingShare\.sweepOrphansOnce\(this\)/);
  });
});
