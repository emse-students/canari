import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAIL_PUSH_MODES } from './appVersion';

/**
 * THE MAIL PUSH SWITCH IS SPELLED IN FIVE PLACES, AND THEY MUST SPELL IT THE SAME (mail lot 5) - the
 * reasoning of `mailModesAgree.test.ts`: the SQL CHECK decides what the column may hold, core's
 * entity what the admin route accepts, chat-delivery's reader what the hook understands, this
 * client's list what the admin page offers and the client reads, and the page labels every one.
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

/** The quoted values of the first match of `pattern`'s single capture group. */
function quotedValues(text: string, pattern: RegExp): string[] {
  const match = pattern.exec(text);
  expect(match, `no match for ${pattern}`).not.toBeNull();
  return [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('the five copies of the mail push modes', () => {
  const expected = [...MAIL_PUSH_MODES];

  it('the SQL CHECK of core migration 034, whose default is none', () => {
    const sql = read('apps/core-service/src/migrations/034_platform_config_mail_push.sql');
    expect(quotedValues(sql, /CHECK \(mail_push IN \(([^)]*)\)\)/)).toEqual(expected);
    expect(sql).toMatch(/mail_push VARCHAR\(16\) NOT NULL DEFAULT 'none'/);
  });

  it.each([
    [
      'core-service',
      'apps/core-service/src/platform/entities/platform-config.entity.ts',
      'MAIL_PUSH_MODES',
    ],
    [
      'chat-delivery-service',
      'apps/chat-delivery-service/src/utils/mail-push.ts',
      'MAIL_PUSH_MODES',
    ],
    ['the frontend', 'frontend/src/lib/utils/appVersion.ts', 'MAIL_PUSH_MODES'],
  ])('the MailPush type and list of %s', (_service, path, list) => {
    const source = read(path);
    expect(quotedValues(source, /export type MailPush = ([^;]*);/)).toEqual(expected);
    expect(quotedValues(source, new RegExp(`export const ${list}[^=]*= \\[([^\\]]*)\\]`))).toEqual(
      expected
    );
  });

  it('the admin page offers MAIL_PUSH_MODES and labels every one', () => {
    const page = read('frontend/src/routes/admin/platform/+page.svelte');
    expect(page).toContain('MAIL_PUSH_MODES.map(');
    for (const mode of expected) {
      expect(page).toMatch(new RegExp(`\\b${mode}: m\\.admin_platform_mail_push_`));
    }
  });
});
