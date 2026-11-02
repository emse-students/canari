import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PUSH_MODES } from './pushMode';

/**
 * THE PUSH SWITCH IS SPELLED IN FIVE PLACES, AND THEY MUST SPELL IT THE SAME - the reasoning of
 * `livesModesAgree.test.ts`: the SQL CHECK decides what the column may hold, core's entity what the
 * admin route accepts, chat-delivery's reader what the push path obeys, this list what the admin page
 * offers, and the page labels every one. chat-delivery's reader throws on a value it does not know,
 * so a drift stops every capable device's pushes: read here as TEXT, since three copies live in other
 * packages.
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

/** The quoted values of the first match of `pattern`'s single capture group. */
function quotedValues(text: string, pattern: RegExp): string[] {
  const match = pattern.exec(text);
  expect(match, `no match for ${pattern}`).not.toBeNull();
  return [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('the five copies of the push modes', () => {
  const expected = [...PUSH_MODES];

  it("the SQL CHECK of migration 018, whose default is today's payload", () => {
    const sql = read('apps/core-service/src/migrations/018_platform_config_push_mode.sql');
    expect(quotedValues(sql, /CHECK \(push_mode IN \(([^)]*)\)\)/)).toEqual(expected);
    expect(sql).toMatch(/push_mode VARCHAR\(16\) NOT NULL DEFAULT 'full'/);
  });

  it.each([
    ['core-service', 'apps/core-service/src/platform/entities/platform-config.entity.ts'],
    ['chat-delivery-service', 'apps/chat-delivery-service/src/utils/push-mode.ts'],
    ['the frontend', 'frontend/src/lib/admin/pushMode.ts'],
  ])('the PushMode type and PUSH_MODES list of %s', (_service, path) => {
    const source = read(path);
    expect(quotedValues(source, /export type PushMode = ([^;]*);/)).toEqual(expected);
    expect(quotedValues(source, /export const PUSH_MODES[^=]*= \[([^\]]*)\]/)).toEqual(expected);
  });

  it('the admin page offers PUSH_MODES and labels every one', () => {
    const page = read('frontend/src/routes/admin/platform/+page.svelte');
    expect(page).toContain('PUSH_MODES.map(');
    for (const mode of expected) expect(page).toMatch(new RegExp(`\\b${mode}: m\\.`));
  });
});
