/**
 * The client's half of `libs/contracts/presence-audience.cases.json`: the most ids one presence
 * request carries is the cap the gateway (`MAX_PRESENCE_USERS`) and both services refuse above. A
 * client splitting at more than that would turn every long watchlist into a 400.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRESENCE_IDS_PER_REQUEST } from './presenceStore';

const CONTRACT = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'presence-audience.cases.json'),
    'utf8'
  )
) as { maxUserIds: number };

describe('the presence request size follows the shared presence-audience contract', () => {
  it('splits at exactly the cap the gateway and the services refuse above', () => {
    expect(PRESENCE_IDS_PER_REQUEST).toBe(CONTRACT.maxUserIds);
  });
});
