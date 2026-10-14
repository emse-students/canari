/**
 * Source guard for the shell's half of community-open-budget F1/F2: the listing starts on the
 * ACCESS TOKEN (a session the server answered for the account on screen), not on MLS-ready, and a
 * sign-out forgets the account's list. Both live in a `.svelte` component no unit test mounts, so
 * this reads its source - the same pattern as `reconnectListingWiring.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src/lib/components/layout/ChatBackgroundService.svelte'),
  'utf8'
);

describe('ChatBackgroundService - the community listing trigger', () => {
  it('starts the listing when the server answered for the account on screen, before MLS', () => {
    expect(source).toMatch(
      /const listingMayStart = \$derived\(\s*globalSession\.isLoggedIn \|\|\s*\(sessionAnsweredFor\(\) !== null && sessionAnsweredFor\(\) === currentUserId\(\)\)/
    );
    expect(source).toMatch(/if \(!listingMayStart\) return;/);
  });

  it('forgets the account list on sign-out', () => {
    const handler = source.slice(source.indexOf('function handleSignedOut'));
    expect(handler.slice(0, 1500)).toContain('globalChannels.forgetAccount(appendLog)');
  });
});
