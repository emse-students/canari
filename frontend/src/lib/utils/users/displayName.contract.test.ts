import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The label is mocked rather than compiled: this file asserts a PRECEDENCE, and which words the
// unknown-user case reads in is the one thing the shared contract deliberately does not pin.
vi.mock('$lib/paraglide/messages', () => ({
  m: { user_unknown_label: () => 'Utilisateur inconnu' },
}));

import { formatProfileDisplayName } from './displayName';

/**
 * ONE CONTRACT, READ FROM DISK RATHER THAN RESTATED.
 *
 * Three implementations build a person's name out of the same three columns - this one,
 * chat-delivery-service's and social-service's - and there is no shared TypeScript package between
 * them, so the precedence they must agree on is shared as DATA. A case added to the JSON file fails
 * in all three at once, which is the only thing that stops them drifting apart again: until
 * 2026-09-22 the servers preferred `displayName` and this file preferred `firstName lastName`, so
 * the same account could be titled one way in a push notification and another way in the screen
 * that notification opened.
 */
interface ContractCase {
  name: string;
  row: { displayName: string | null; firstName: string | null; lastName: string | null };
  expected: string | null;
}

const CONTRACT = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      'libs',
      'contracts',
      'user-display-name.cases.json'
    ),
    'utf8'
  )
) as { cases: ContractCase[] };

describe('formatProfileDisplayName follows the shared contract', () => {
  it('reads a contract that actually has cases in it', () => {
    expect(CONTRACT.cases.length).toBeGreaterThan(0);
  });

  it.each(CONTRACT.cases)('$name', ({ row, expected }) => {
    // `expected: null` is "this row carries no name"; a person has to read something, so this
    // implementation answers it with the localized unknown-user label.
    expect(formatProfileDisplayName(row)).toBe(expected ?? 'Utilisateur inconnu');
  });
});
