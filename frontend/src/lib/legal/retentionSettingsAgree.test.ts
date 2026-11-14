import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RETENTION_ADMIN_SETTINGS, RETENTION_DEFAULTS, parseRetention } from './retention';

/**
 * THE RETENTION DURATIONS ARE SPELLED IN FIVE PLACES, AND THEY MUST AGREE (owner, 2026-11-14:
 * "the privacy policy renders the values in force from the same source, so they can never
 * disagree"). Core migration 025 creates each column with its default and CHECK, core's
 * `RETENTION_SETTINGS` validates the admin route against the same bounds, social-service's reader
 * names the columns, this client's defaults are what the policy shows when no answer was ever read,
 * and the policy and the admin page render every one. Read as TEXT, since four copies live in other
 * packages.
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

const COLUMNS: Record<keyof typeof RETENTION_DEFAULTS, string> = {
  reelDays: 'retention_reel_days',
  liveReplayDays: 'retention_live_replay_days',
  chatReelDays: 'retention_chat_reel_days',
  idleMediaDays: 'retention_idle_media_days',
};

describe('the copies of the retention durations', () => {
  const sql = read('apps/core-service/src/migrations/025_platform_config_retention.sql');
  const core = read('apps/core-service/src/platform/retention.ts');
  const social = read('apps/social-service/src/common/retention-settings.ts');

  it.each(RETENTION_ADMIN_SETTINGS.map((s) => [s.publicKey, s] as const))(
    '%s: the migration default and CHECK, and core list, match this client',
    (publicKey, setting) => {
      const column = COLUMNS[publicKey];
      const def = RETENTION_DEFAULTS[publicKey];
      expect(sql).toMatch(new RegExp(`${column} INTEGER NOT NULL DEFAULT ${def};`));
      expect(sql).toMatch(
        new RegExp(`CHECK \\(${column} BETWEEN ${setting.minDays} AND ${setting.maxDays}\\)`)
      );
      expect(core).toMatch(
        new RegExp(
          `key: '${setting.key}',\\s*column: '${column}',\\s*defaultDays: ${def},\\s*minDays: ${setting.minDays},\\s*maxDays: ${setting.maxDays},`
        )
      );
      expect(social).toMatch(
        new RegExp(`key: '${publicKey}', column: '${column}', defaultDays: ${def} `)
      );
    }
  );

  it('the privacy policy renders every duration from the server answer, never a typed number', () => {
    const page = read('frontend/src/routes/legal/privacy/+page.svelte');
    for (const key of Object.keys(RETENTION_DEFAULTS)) {
      expect(page).toContain(`durationLabel(retention.days.${key})`);
    }
    expect(page).not.toMatch(/CanaReels du fil : un an/);
    expect(page).not.toMatch(/CanaReels de conversation : 30 jours/);
  });

  it('the admin page offers every setting and labels each', () => {
    const page = read('frontend/src/routes/admin/platform/+page.svelte');
    expect(page).toContain('RETENTION_ADMIN_SETTINGS as setting');
    for (const { key } of RETENTION_ADMIN_SETTINGS) {
      expect(page).toMatch(new RegExp(`\\b${key}: m\\.admin_platform_retention_`));
    }
  });
});

describe('parseRetention', () => {
  it('reads the four durations a server publishes', () => {
    expect(
      parseRetention({ reelDays: 180, liveReplayDays: 3, chatReelDays: 30, idleMediaDays: 90 })
    ).toEqual({ reelDays: 180, liveReplayDays: 3, chatReelDays: 30, idleMediaDays: 90 });
  });

  it.each([
    undefined,
    null,
    {},
    { reelDays: 180, liveReplayDays: 3, chatReelDays: 30 },
    { reelDays: 0, liveReplayDays: 3, chatReelDays: 30, idleMediaDays: 90 },
    { reelDays: '365', liveReplayDays: 3, chatReelDays: 30, idleMediaDays: 90 },
  ])('is null for %j - never a partial answer mixed with defaults', (raw) => {
    expect(parseRetention(raw)).toBeNull();
  });
});
