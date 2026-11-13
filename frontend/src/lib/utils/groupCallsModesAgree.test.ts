import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GROUP_CALLS_MODES } from './appVersion';

/**
 * THE GROUP CALLS SWITCH IS SPELLED IN FIVE PLACES, AND THEY MUST SPELL IT THE SAME - the reasoning
 * of `callsModesAgree.test.ts`: the SQL CHECK decides what the column may hold, core's entity what
 * the admin route accepts, chat-delivery's reader what `initiate` enforces, this client's list what
 * it obeys, and the admin page what it offers. Read as TEXT, since three copies live in other packages.
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

/** The quoted values of the first match of `pattern`'s single capture group. */
function quotedValues(text: string, pattern: RegExp): string[] {
  const match = pattern.exec(text);
  expect(match, `no match for ${pattern}`).not.toBeNull();
  return [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('the five copies of the group calls modes', () => {
  const expected = [...GROUP_CALLS_MODES];

  it("the SQL CHECK of core migration 022, whose default is today's no group call", () => {
    const sql = read('apps/core-service/src/migrations/022_platform_config_group_calls_mode.sql');
    expect(quotedValues(sql, /CHECK \(group_calls_mode IN \(([^)]*)\)\)/)).toEqual(expected);
    expect(sql).toMatch(/group_calls_mode VARCHAR\(16\) NOT NULL DEFAULT 'off'/);
  });

  it.each([
    ['core-service', 'apps/core-service/src/platform/entities/platform-config.entity.ts'],
    ['chat-delivery-service', 'apps/chat-delivery-service/src/utils/group-calls-mode.ts'],
    ['the frontend', 'frontend/src/lib/utils/appVersion.ts'],
  ])('the GroupCallsMode type and GROUP_CALLS_MODES list of %s', (_service, path) => {
    const source = read(path);
    expect(quotedValues(source, /export type GroupCallsMode = ([^;]*);/)).toEqual(expected);
    expect(quotedValues(source, /export const GROUP_CALLS_MODES[^=]*= \[([^\]]*)\]/)).toEqual(
      expected
    );
  });

  it('the admin page offers GROUP_CALLS_MODES and labels every one', () => {
    const page = read('frontend/src/routes/admin/platform/+page.svelte');
    expect(page).toContain('GROUP_CALLS_MODES.map(');
    for (const mode of expected) {
      expect(page).toMatch(new RegExp(`\\b${mode}: m\\.admin_platform_group_calls_mode_`));
    }
  });
});
