import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIVE_REPLAYS_MODES } from './appVersion';

/**
 * THE LIVE REPLAYS SWITCH IS SPELLED IN FIVE PLACES, AND THEY MUST SPELL IT THE SAME - the reasoning
 * of `livesModesAgree.test.ts`: the SQL CHECK decides what the column may hold, core's entity what
 * the admin route accepts, social-service's reader what a live's start understands (it THROWS on a
 * value it does not know, so a drift would refuse every start), this client's list what the admin
 * page offers, and the page labels every one. Read as TEXT, since three copies live in other packages.
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

/** The quoted values of the first match of `pattern`'s single capture group. */
function quotedValues(text: string, pattern: RegExp): string[] {
  const match = pattern.exec(text);
  expect(match, `no match for ${pattern}`).not.toBeNull();
  return [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('the five copies of the live replays modes', () => {
  const expected = [...LIVE_REPLAYS_MODES];

  it("the SQL CHECK of core migration 021, whose default is today's deletion at the end", () => {
    const sql = read('apps/core-service/src/migrations/021_platform_config_live_replays_mode.sql');
    expect(quotedValues(sql, /CHECK \(live_replays_mode IN \(([^)]*)\)\)/)).toEqual(expected);
    expect(sql).toMatch(/live_replays_mode VARCHAR\(16\) NOT NULL DEFAULT 'off'/);
  });

  it.each([
    ['core-service', 'apps/core-service/src/platform/entities/platform-config.entity.ts'],
    ['social-service', 'apps/social-service/src/lives/live-replays-mode.ts'],
    ['the frontend', 'frontend/src/lib/utils/appVersion.ts'],
  ])('the LiveReplaysMode type and LIVE_REPLAYS_MODES list of %s', (_service, path) => {
    const source = read(path);
    expect(quotedValues(source, /export type LiveReplaysMode = ([^;]*);/)).toEqual(expected);
    expect(quotedValues(source, /export const LIVE_REPLAYS_MODES[^=]*= \[([^\]]*)\]/)).toEqual(
      expected
    );
  });

  it('the admin page offers LIVE_REPLAYS_MODES and labels every one', () => {
    const page = read('frontend/src/routes/admin/platform/+page.svelte');
    expect(page).toContain('LIVE_REPLAYS_MODES.map(');
    for (const mode of expected) {
      expect(page).toMatch(new RegExp(`\\b${mode}: m\\.admin_platform_live_replays_mode_`));
    }
  });
});
