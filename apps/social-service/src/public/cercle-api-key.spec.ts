import { ForbiddenException } from '@nestjs/common';
import { assertCercleApiKey } from './cercle-api-key';

/** The gate of `cotisant-status`: the configured key passes, anything else - or no key set - is 403. */
describe('assertCercleApiKey', () => {
  const ORIGINAL = process.env.CERCLE_API_KEY;
  afterEach(() => {
    process.env.CERCLE_API_KEY = ORIGINAL;
  });

  it('passes the configured key, refuses another of any length and a missing one', () => {
    process.env.CERCLE_API_KEY = 'cercle-key';
    expect(() => assertCercleApiKey('cercle-key')).not.toThrow();
    expect(() => assertCercleApiKey('cercle-kez')).toThrow(ForbiddenException);
    expect(() => assertCercleApiKey('short')).toThrow(ForbiddenException);
    expect(() => assertCercleApiKey(undefined)).toThrow(ForbiddenException);
  });

  it('refuses everything while no key is configured', () => {
    process.env.CERCLE_API_KEY = '';
    expect(() => assertCercleApiKey('')).toThrow(ForbiddenException);
  });
});
