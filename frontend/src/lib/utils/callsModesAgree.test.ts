import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CALLS_MODES } from './appVersion';

/**
 * THE CALLS KILL SWITCH IS SPELLED IN FIVE PLACES, AND THEY MUST SPELL IT THE SAME.
 *
 * The SQL CHECK decides what the column may hold, core's entity what the admin route accepts,
 * chat-delivery's reader what it enforces, this client's list what it obeys, and the admin page
 * what it offers. A value added to one and not another is a mode the admin can set and a service
 * reads as `off` (or one the database refuses) - silently, because every reader fails closed. This
 * test reads the four other copies as TEXT, since three of them live in other packages.
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

/** The quoted values of the first match of `pattern`'s single capture group. */
function quotedValues(text: string, pattern: RegExp): string[] {
  const match = pattern.exec(text);
  expect(match, `no match for ${pattern}`).not.toBeNull();
  return [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('the five copies of the calls modes', () => {
  const expected = [...CALLS_MODES];

  it('the SQL CHECK of migration 014', () => {
    const sql = read('apps/core-service/src/migrations/014_platform_config_calls_mode.sql');
    expect(quotedValues(sql, /CHECK \(calls_mode IN \(([^)]*)\)\)/)).toEqual(expected);
  });

  it.each([
    ['core-service', 'apps/core-service/src/platform/entities/platform-config.entity.ts'],
    ['chat-delivery-service', 'apps/chat-delivery-service/src/utils/calls-mode.ts'],
    ['the frontend', 'frontend/src/lib/utils/appVersion.ts'],
  ])('the CallsMode type and CALLS_MODES list of %s', (_service, path) => {
    const source = read(path);
    expect(quotedValues(source, /export type CallsMode = ([^;]*);/)).toEqual(expected);
    expect(quotedValues(source, /export const CALLS_MODES[^=]*= \[([^\]]*)\]/)).toEqual(expected);
  });

  it('the admin page offers CALLS_MODES and labels every one', () => {
    const page = read('frontend/src/routes/admin/platform/+page.svelte');
    expect(page).toContain('CALLS_MODES.map(');
    for (const mode of expected) expect(page).toMatch(new RegExp(`\\b${mode}: m\\.`));
  });
});
