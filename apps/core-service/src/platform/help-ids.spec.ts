/// <reference types="jest" />

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HELP_ID_UNKNOWN, HELP_IDS, isHelpId } from './help-ids';

/**
 * The allowlist is the contract's, entry for entry: a help the client declares and this list lacks
 * would be refused on every device, and one this list keeps after the client dropped it is a row
 * nobody can ever write - harmless, but a drift the next reader cannot explain.
 */
describe('HELP_IDS', () => {
  const contract = JSON.parse(
    readFileSync(
      join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'help-ids.json'),
      'utf8'
    )
  ) as { ids: string[]; unknownIdCode: string };

  it('equals libs/contracts/help-ids.json', () => {
    expect([...HELP_IDS]).toEqual(contract.ids);
  });

  it('refuses with the code the contract names', () => {
    expect(HELP_ID_UNKNOWN).toBe(contract.unknownIdCode);
  });

  it('accepts a listed id and refuses anything else', () => {
    expect(isHelpId('welcome-tour')).toBe(true);
    expect(isHelpId('Welcome-Tour')).toBe(false);
    expect(isHelpId('welcome-tour ')).toBe(false);
    expect(isHelpId('')).toBe(false);
    expect(isHelpId(undefined)).toBe(false);
    expect(isHelpId('x'.repeat(10_000))).toBe(false);
  });
});
