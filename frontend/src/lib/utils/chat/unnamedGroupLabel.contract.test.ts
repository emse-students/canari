import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * The client's half of `libs/contracts/unnamed-group-label.cases.json`, whose other half is Rust's
 * `compose_unnamed_group_label` (the push drawn while the app is dead, both platforms). The words are
 * read from the app's own message files in the language each case is asserted in, so the case pins
 * the rule AND the wording of both languages at once.
 */

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
type Messages = Record<string, string>;
const MESSAGES: Record<'fr' | 'en', Messages> = {
  fr: JSON.parse(readFileSync(join(ROOT, 'frontend', 'messages', 'fr.json'), 'utf8')) as Messages,
  en: JSON.parse(readFileSync(join(ROOT, 'frontend', 'messages', 'en.json'), 'utf8')) as Messages,
};
const language = vi.hoisted(() => ({ current: 'fr' as 'fr' | 'en' }));

vi.mock('$lib/paraglide/messages', () => {
  const fill = (key: string) => (params: Record<string, string | number>) =>
    Object.entries(params).reduce(
      (text, [name, value]) => text.replace(`{${name}}`, String(value)),
      MESSAGES[language.current][key]
    );
  return {
    m: {
      group_default_name_two: fill('group_default_name_two'),
      group_default_name_three: fill('group_default_name_three'),
      group_default_name_more: fill('group_default_name_more'),
    },
  };
});

import { composeUnnamedGroupLabel } from './unnamedGroupLabel';

interface ContractCase {
  name: string;
  members: string[];
  viewer: string;
  names: Record<string, string>;
  fr: string | null;
  en: string | null;
}

const CONTRACT = JSON.parse(
  readFileSync(join(ROOT, 'libs', 'contracts', 'unnamed-group-label.cases.json'), 'utf8')
) as { cases: ContractCase[] };

describe('composeUnnamedGroupLabel follows the shared contract', () => {
  it('reads a contract that actually has cases in it', () => {
    expect(CONTRACT.cases.length).toBeGreaterThan(0);
  });

  for (const lang of ['fr', 'en'] as const) {
    it.each(CONTRACT.cases)(`${lang}: $name`, (c) => {
      language.current = lang;
      expect(composeUnnamedGroupLabel(c.members, c.viewer, (id) => c.names[id] ?? '')).toBe(
        c[lang]
      );
    });
  }
});
