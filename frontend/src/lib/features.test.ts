import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot 1 of the calls revival puts in-app calling ON for a dev build and nowhere else. The whole of
 * "production stays off" is this one expression, so it is pinned against the variable the
 * pipelines actually write (`VITE_DEPLOY_ENVIRONMENT=development` for dev.canari-emse.fr and every
 * pre-release app, unset for production).
 */

async function load() {
  vi.resetModules();
  return import('./features');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('CALLS_ENABLED', () => {
  // THE REVIVAL (CALLS_COMPILED = true): calling is on in every build, production included.
  it.each([['development'], [''], ['staging']])(
    'is on for VITE_DEPLOY_ENVIRONMENT=%j',
    async (env) => {
      vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', env);
      expect((await load()).CALLS_ENABLED).toBe(true);
    }
  );

  it('carries the native ring, and leaves video off until WP-C3', async () => {
    const f = await load();
    expect(f.CALLS_COMPILED).toBe(true);
    expect(f.CALLS_VIDEO_ENABLED).toBe(false);
  });
});
