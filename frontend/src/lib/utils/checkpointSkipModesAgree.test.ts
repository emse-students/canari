import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHECKPOINT_SKIP_MODES } from './appVersion';

/**
 * THE CHECKPOINT-SKIP SWITCH IS SPELLED IN FOUR PLACES, AND THEY MUST SPELL IT THE SAME - the
 * reasoning of `livesModesAgree.test.ts`: the SQL CHECK decides what the column may hold, core's
 * entity what the admin route accepts, this client's list what `/api/version` is read as, and the
 * admin page labels every one. A drift here reads silently as `off` on every client, so the switch
 * would look moved and change nothing. Read as TEXT, since two copies live in another package.
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

/** The quoted values of the first match of `pattern`'s single capture group. */
function quotedValues(text: string, pattern: RegExp): string[] {
  const match = pattern.exec(text);
  expect(match, `no match for ${pattern}`).not.toBeNull();
  return [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('the four copies of the checkpoint-skip modes', () => {
  const expected = [...CHECKPOINT_SKIP_MODES];

  it("the SQL CHECK of migration 020, whose default is today's durability", () => {
    const sql = read(
      'apps/core-service/src/migrations/020_platform_config_checkpoint_skip_mode.sql'
    );
    expect(quotedValues(sql, /CHECK \(checkpoint_skip_mode IN \(([^)]*)\)\)/)).toEqual(expected);
    expect(sql).toMatch(/checkpoint_skip_mode VARCHAR\(16\) NOT NULL DEFAULT 'off'/);
  });

  it.each([
    ['core-service', 'apps/core-service/src/platform/entities/platform-config.entity.ts'],
    ['the frontend', 'frontend/src/lib/utils/appVersion.ts'],
  ])('the CheckpointSkipMode type and CHECKPOINT_SKIP_MODES list of %s', (_service, path) => {
    const source = read(path);
    expect(quotedValues(source, /export type CheckpointSkipMode = ([^;]*);/)).toEqual(expected);
    expect(quotedValues(source, /export const CHECKPOINT_SKIP_MODES[^=]*= \[([^\]]*)\]/)).toEqual(
      expected
    );
  });

  it('the admin page offers CHECKPOINT_SKIP_MODES and labels every one', () => {
    const page = read('frontend/src/routes/admin/platform/+page.svelte');
    expect(page).toContain('CHECKPOINT_SKIP_MODES.map(');
    for (const mode of expected) expect(page).toMatch(new RegExp(`\\b${mode}: m\\.`));
  });
});
