import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CALL_RELAYS } from './appVersion';

/**
 * THE CALL RELAY IS SPELLED IN FIVE PLACES, AND THEY MUST SPELL IT THE SAME - the reasoning of
 * `groupCallsModesAgree.test.ts`: the SQL CHECK decides what the column may hold, core's entity what
 * the admin route accepts, chat-delivery's reader what `initiate` acts on, this client's list what
 * it reads, and the admin page what it offers. Read as TEXT, since three copies live in other packages.
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

/** The quoted values of the first match of `pattern`'s single capture group. */
function quotedValues(text: string, pattern: RegExp): string[] {
  const match = pattern.exec(text);
  expect(match, `no match for ${pattern}`).not.toBeNull();
  return [...match![1].matchAll(/'([a-z_-]+)'/g)].map((m) => m[1]);
}

describe('the five copies of the call relays', () => {
  const expected = [...CALL_RELAYS];

  it("the SQL CHECK of core migration 023, whose default is today's no relay", () => {
    const sql = read('apps/core-service/src/migrations/023_platform_config_call_relay.sql');
    expect(quotedValues(sql, /CHECK \(call_relay IN \(([^)]*)\)\)/)).toEqual(expected);
    expect(sql).toMatch(/call_relay VARCHAR\(16\) NOT NULL DEFAULT 'none'/);
  });

  it.each([
    ['core-service', 'apps/core-service/src/platform/entities/platform-config.entity.ts'],
    ['chat-delivery-service', 'apps/chat-delivery-service/src/utils/call-relay.ts'],
    ['the frontend', 'frontend/src/lib/utils/appVersion.ts'],
  ])('the CallRelay type and CALL_RELAYS list of %s', (_service, path) => {
    const source = read(path);
    expect(quotedValues(source, /export type CallRelay = ([^;]*);/)).toEqual(expected);
    expect(quotedValues(source, /export const CALL_RELAYS[^=]*= \[([^\]]*)\]/)).toEqual(expected);
  });

  it('the admin page offers CALL_RELAYS and labels every one', () => {
    const page = read('frontend/src/routes/admin/platform/+page.svelte');
    expect(page).toContain('CALL_RELAYS.map(');
    for (const relay of expected) {
      const key = relay.includes('-') ? `'${relay}'` : relay;
      expect(page).toContain(`${key}: m.admin_platform_call_relay_`);
    }
  });
});
