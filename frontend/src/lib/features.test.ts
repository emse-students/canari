import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Calls are compiled into every build since the flip of 2026-10-22 (audio 1:1, in-app); production
 * is held shut by the server's `calls_mode`, not here. What still depends on the variable the
 * pipelines write (`VITE_DEPLOY_ENVIRONMENT=development` for dev.canari-emse.fr and every
 * pre-release app, unset for production) is VIDEO, which stays dev only.
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

  it('is on for a production build, which sets nothing (the flip, 2026-10-22)', async () => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', '');
    expect((await load()).CALLS_ENABLED).toBe(true);
  });

  it('is on for a value nobody planned for: the server kill switch is what closes it', async () => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', 'staging');
    expect((await load()).CALLS_ENABLED).toBe(true);
  });

  it('compiles the native ring into every build, whatever the environment (owner, 2026-10-30)', async () => {
    // Its own fact (B2'), a constant like CALLS_COMPILED: no environment turns it on or off.
    for (const env of ['development', '']) {
      vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', env);
      expect((await load()).CALLS_NATIVE_RING_COMPILED).toBe(true);
    }
  });

  it('compiles calls into the store binaries (the flip, 2026-10-22)', async () => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', '');
    expect((await load()).CALLS_COMPILED).toBe(true);
  });

  it('carries video on a dev build, never production (lot 2)', async () => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', 'development');
    expect((await load()).CALLS_VIDEO_ENABLED).toBe(true);
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', '');
    expect((await load()).CALLS_VIDEO_ENABLED).toBe(false);
  });
});

describe('the first production calls are AUDIO ONLY (owner, 2026-10-21)', () => {
  // The flip moved CALLS_COMPILED and nothing else here. Video must not ride along: it is
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
