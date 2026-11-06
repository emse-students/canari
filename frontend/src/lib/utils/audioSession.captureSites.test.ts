/**
 * EVERY MICROPHONE IS OPENED THROUGH `captureUserMedia` (review of #3018, 2026-11-04).
 *
 * Under a page-set audio session type other than `play-and-record`, WebKit REJECTS an audio
 * `getUserMedia` (`InvalidStateError`). `captureUserMedia` holds the microphone - and so sets that
 * type - before it asks. A capture site that called `getUserMedia` with audio directly would break
 * on an iPhone as soon as the session is `ambient`, which it is from the first tone on; this scan
 * fails on it. A video-only `getUserMedia` (a call's camera) may stay direct. KNOWN GAP: it reads
 * the call's text, so constraints passed as a VARIABLE (`getUserMedia(constraints)`) slip through.
 */
import { expect, it } from 'vitest';
import { relativeTo, sourceFiles } from '../../test/sourceTree';

/** The one implementation, which is allowed to call `getUserMedia` with audio. */
const OWNER = 'lib/utils/audioSession.ts';

it('no capture site calls getUserMedia with audio except audioSession.ts', () => {
  const offenders: string[] = [];
  // The run's shared snapshot, read once: this scan never touches the disk (test-suite-reform s8).
  // The snapshot holds no generated tree (`wasm`, `paraglide`, `proto`), as the walk it replaces skipped.
  const files = sourceFiles({ under: 'src', extensions: ['ts', 'svelte'], tests: 'exclude' });
  // It is reading the tree it thinks it is: the one owner is in it.
  expect(files.some((f) => relativeTo(f.path, 'src') === OWNER)).toBe(true);
  for (const { path, text } of files) {
    const rel = relativeTo(path, 'src');
    if (rel === OWNER || rel.endsWith('.test-helper.ts')) continue;
    for (const match of text.matchAll(/\.getUserMedia\(/g)) {
      // The constraints of this call: up to its closing parenthesis, which a few lines hold.
      const call = text.slice(match.index, match.index + 400);
      const end = call.indexOf(');');
      const args = end >= 0 ? call.slice(0, end) : call;
      if (/\baudio\b/.test(args)) offenders.push(`${rel}: ${args.split('\n')[0]}`);
    }
  }
  expect(offenders).toEqual([]);
});
