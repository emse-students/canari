import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAIL_MODES } from './appVersion';

/**
 * THE MAIL SWITCH IS SPELLED IN FOUR PLACES, AND THEY MUST SPELL IT THE SAME - the reasoning of
 * `liveReplaysModesAgree.test.ts`: the SQL CHECK decides what the column may hold, core's entity
 * what the admin route accepts, this client's list what the admin page offers, and the page labels
 * every one. Read as TEXT, since two copies live in another package.
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

/** The quoted values of the first match of `pattern`'s single capture group. */
function quotedValues(text: string, pattern: RegExp): string[] {
  const match = pattern.exec(text);
  expect(match, `no match for ${pattern}`).not.toBeNull();
  return [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('the four copies of the mail modes', () => {
  const expected = [...MAIL_MODES];

  it('the SQL CHECK of core migration 033, whose default hides the tab', () => {
    const sql = read('apps/core-service/src/migrations/033_platform_config_mail_mode.sql');
    expect(quotedValues(sql, /CHECK \(mail_mode IN \(([^)]*)\)\)/)).toEqual(expected);
    expect(sql).toMatch(/mail_mode VARCHAR\(16\) NOT NULL DEFAULT 'off'/);
  });

  it.each([
    ['core-service', 'apps/core-service/src/platform/entities/platform-config.entity.ts'],
    ['the frontend', 'frontend/src/lib/utils/appVersion.ts'],
  ])('the MailMode type and MAIL_MODES list of %s', (_service, path) => {
    const source = read(path);
    expect(quotedValues(source, /export type MailMode = ([^;]*);/)).toEqual(expected);
    expect(quotedValues(source, /export const MAIL_MODES[^=]*= \[([^\]]*)\]/)).toEqual(expected);
  });

  it('the admin page offers MAIL_MODES and labels every one', () => {
    const page = read('frontend/src/routes/admin/platform/+page.svelte');
    expect(page).toContain('MAIL_MODES.map(');
    for (const mode of expected) {
      expect(page).toMatch(new RegExp(`\\b${mode}: m\\.admin_platform_mail_mode_`));
    }
  });
});
