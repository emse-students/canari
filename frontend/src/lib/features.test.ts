import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('carries video on a dev build, never production (lot 2)', async () => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', 'development');
    expect((await load()).CALLS_VIDEO_ENABLED).toBe(true);
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', '');
    expect((await load()).CALLS_VIDEO_ENABLED).toBe(false);
  });
});

describe('the first production calls are AUDIO ONLY (owner, 2026-10-21)', () => {
  // The revival commit flips CALLS_COMPILED and nothing else here. Video must not ride along: it is
  // read from the expression, because CALLS_COMPILED is a constant this suite cannot stub.
  it('video does not follow CALLS_COMPILED', async () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'features.ts'),
      'utf8'
    );
    const expression = source.match(/export const CALLS_VIDEO_ENABLED = ([^;]+);/);
    expect(expression, 'CALLS_VIDEO_ENABLED was renamed or removed').not.toBeNull();
    expect(expression![1]).not.toMatch(/CALLS_COMPILED|CALLS_ENABLED/);
  });
});
