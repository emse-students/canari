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
  it('is on for a dev build', async () => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', 'development');
    expect((await load()).CALLS_ENABLED).toBe(true);
  });

  it('is off for a production build, which sets nothing', async () => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', '');
    expect((await load()).CALLS_ENABLED).toBe(false);
  });

  it('is off for a value nobody planned for', async () => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', 'staging');
    expect((await load()).CALLS_ENABLED).toBe(false);
  });

  it('leaves the native ring off whatever the build', async () => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', 'development');
    const f = await load();
    expect(f.CALLS_COMPILED).toBe(false);
  });

  it('carries video exactly where calls are (lot 2): a dev build, never production', async () => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', 'development');
    expect((await load()).CALLS_VIDEO_ENABLED).toBe(true);
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', '');
    expect((await load()).CALLS_VIDEO_ENABLED).toBe(false);
  });
});
