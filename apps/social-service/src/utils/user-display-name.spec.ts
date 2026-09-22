import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatUserDisplayName,
  formatUserDisplayNameFromRaw,
  type UserNameRow,
} from './user-display-name';

/**
 * ONE CONTRACT, READ FROM DISK RATHER THAN RESTATED.
 *
 * This spec is BYTE-IDENTICAL in chat-delivery-service and social-service, beside the file it
 * guards, and declared as such: a copied module needs a copied test beside it, or one service
 * asserts the behaviour and the other only inherits the file.
 *
 * The contract itself is shared with a THIRD implementation the duplicate detector cannot reach -
 * the frontend's `formatProfileDisplayName`, which is legitimately different code answering the
 * same question. A case added to the JSON fails here and there at once, which is the only thing
 * that stops them drifting apart again: until 2026-09-22 the servers preferred `displayName` and
 * the client preferred `firstName lastName`, and nothing asked the two the same question.
 */
interface ContractCase {
  name: string;
  row: UserNameRow;
  expected: string | null;
}

const CONTRACT: { cases: ContractCase[] } = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'user-display-name.cases.json'),
    'utf8'
  )
) as { cases: ContractCase[] };

describe('formatUserDisplayName', () => {
  it('reads a contract that actually has cases in it', () => {
    expect(CONTRACT.cases.length).toBeGreaterThan(0);
  });

  it.each(CONTRACT.cases)('$name', ({ row, expected }) => {
    // `expected: null` is "this row carries no name"; the shared function answers that with '' and
    // each caller decides what to say instead.
    expect(formatUserDisplayName(row)).toBe(expected ?? '');
  });

  it.each(CONTRACT.cases)('$name, read from a raw query row', ({ row, expected }) => {
    expect(formatUserDisplayNameFromRaw({ ...row })).toBe(expected ?? '');
  });

  it('ignores a raw column that is not a string', () => {
    expect(formatUserDisplayNameFromRaw({ displayName: 42, firstName: null, lastName: null })).toBe(
      ''
    );
  });
});
