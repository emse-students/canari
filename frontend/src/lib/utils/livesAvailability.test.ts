import { afterEach, describe, expect, it, vi } from 'vitest';

/** The build switch, settable per test: `livesAvailable` reads it at import. */
const build = vi.hoisted(() => ({ live: true }));
vi.mock('$lib/features', async (orig) => ({
  ...(await orig<typeof import('$lib/features')>()),
  get LIVE_ENABLED() {
    return build.live;
  },
}));

import { livesAvailable } from './livesAvailability';

describe('livesAvailable - the build switch AND the server kill switch', () => {
  afterEach(() => {
    build.live = true;
  });

  it('shows the live surfaces only when the build carries lives and the server says on', () => {
    expect(livesAvailable('on')).toBe(true);
    expect(livesAvailable('off')).toBe(false);
  });

  it('hides them in a build without lives, whatever the server says', () => {
    build.live = false;
    expect(livesAvailable('on')).toBe(false);
    expect(livesAvailable('off')).toBe(false);
  });
});
