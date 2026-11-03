import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { HELP_ID_UNKNOWN, HELP_IDS, isHelpId } from './helpIds';
import { GUIDES } from './guides';

const here = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(
  readFileSync(resolve(here, '../../../../libs/contracts/help-ids.json'), 'utf8')
) as { ids: string[]; unknownIdCode: string };

it('lists exactly the ids of libs/contracts/help-ids.json, which the server allows', () => {
  expect([...HELP_IDS]).toEqual(contract.ids);
});

it('reads the refusal code the contract names', () => {
  expect(HELP_ID_UNKNOWN).toBe(contract.unknownIdCode);
});

it('declares every guide under a listed id, once', () => {
  const ids = GUIDES.map((g) => g.id);
  expect(ids.every(isHelpId)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
});

it('refuses anything that is not a listed id', () => {
  expect(isHelpId('welcome-tour')).toBe(true);
  for (const junk of ['', 'WELCOME-TOUR', 'welcome-tour ', 42, null, undefined]) {
    expect(isHelpId(junk)).toBe(false);
  }
});
