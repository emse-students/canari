import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIVES_MODES } from './appVersion';

/**
 * THE LIVES KILL SWITCH IS SPELLED IN SIX PLACES, AND THEY MUST SPELL IT THE SAME - the reasoning
 * of `callsModesAgree.test.ts`, one more copy: the SQL CHECK decides what the column may hold,
 * core's entity what the admin route accepts, social-service's reader what the live routes enforce,
 * media-service's reader what the segment routes enforce, this client's list what it obeys, and the
 * admin page what it offers. Every reader fails closed, so a drift is silent: read here as TEXT,
 * since four of the copies live in other packages.
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

/** The quoted values of the first match of `pattern`'s single capture group. */
function quotedValues(text: string, pattern: RegExp): string[] {
  const match = pattern.exec(text);
  expect(match, `no match for ${pattern}`).not.toBeNull();
  return [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('the six copies of the lives modes', () => {
  const expected = [...LIVES_MODES];

  it('the SQL CHECK of migration 015, whose default is the closed value', () => {
    const sql = read('apps/core-service/src/migrations/015_platform_config_lives_mode.sql');
    expect(quotedValues(sql, /CHECK \(lives_mode IN \(([^)]*)\)\)/)).toEqual(expected);
    expect(sql).toMatch(/lives_mode VARCHAR\(16\) NOT NULL DEFAULT 'off'/);
  });

  it.each([
    ['core-service', 'apps/core-service/src/platform/entities/platform-config.entity.ts'],
    ['social-service', 'apps/social-service/src/lives/lives-mode.ts'],
    ['media-service', 'apps/media-service/src/media/lives-mode.ts'],
    ['the frontend', 'frontend/src/lib/utils/appVersion.ts'],
  ])('the LivesMode type and LIVES_MODES list of %s', (_service, path) => {
    const source = read(path);
    expect(quotedValues(source, /export type LivesMode = ([^;]*);/)).toEqual(expected);
    expect(quotedValues(source, /export const LIVES_MODES[^=]*= \[([^\]]*)\]/)).toEqual(expected);
  });

  it('the admin page offers LIVES_MODES and labels every one', () => {
    const page = read('frontend/src/routes/admin/platform/+page.svelte');
    expect(page).toContain('LIVES_MODES.map(');
    for (const mode of expected) expect(page).toMatch(new RegExp(`\\b${mode}: m\\.`));
  });
});
