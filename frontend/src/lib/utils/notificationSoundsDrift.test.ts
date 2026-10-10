import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE ANDROID NOTIFICATION SOUNDS ARE RENDERED FROM `soundPalette.ts`, AND NOTHING USED TO SAY SO
 * WHEN THE TWO PARTED (2026-10-10).
 *
 * The in-app trills read the palette at run time; the three Android channel sounds are WAV files
 * committed under `res/raw`, rendered offline by `tools/notification-sounds/render.mjs`. Editing
 * the palette and forgetting the re-render left the app and the channels sounding different with
 * every gate green - the doc said "re-run it after ANY palette edit", a rule with no gate. This
 * runs the renderer's own `--check`, which tolerates a rounding step across platforms but not a
 * changed palette.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('Android notification sounds', () => {
  it('are the rendering of the palette the app plays', () => {
    const out = execFileSync(
      'bun',
      [resolve(REPO_ROOT, 'tools/notification-sounds/render.mjs'), '--check'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 }
    );
    expect(out).toContain('common gain');
  }, 90_000);
});
