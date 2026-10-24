import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAFE_QUERY_VALUE_REGEX } from './sanitize';

/**
 * The device ids this service addresses are the ones core-service lets a session name: both sides
 * read `libs/contracts/device-id.json`, so a session can never record a push ending this service
 * would refuse with a 400.
 */
describe('the device id contract', () => {
  it('is the pattern every route here accepts', () => {
    const contract = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'device-id.json'),
        'utf8'
      )
    ) as { pattern: string };
    expect(SAFE_QUERY_VALUE_REGEX.source).toBe(contract.pattern);
  });
});
