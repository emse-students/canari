import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Calls are compiled into every build since the flip of 2026-10-22 (audio 1:1, in-app); production
 * is held shut by the server's `calls_mode`, not here. What still depends on the variable the
 * pipelines write (`VITE_DEPLOY_ENVIRONMENT=development` for dev.canari-emse.fr and every
 * pre-release app, unset for production) is nothing of calls since 1.5.2: video follows calls, and
 * the server's `calls_mode = audio_video` is what opens it. Lives are compiled into every build
 * since 2026-10-30, held by the server's `lives_mode` the same way.
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

  it('carries video on a dev build AND a production build (1.5.2, owner 2026-10-30)', async () => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', 'development');
    expect((await load()).CALLS_VIDEO_ENABLED).toBe(true);
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', '');
    expect((await load()).CALLS_VIDEO_ENABLED).toBe(true);
  });
});

describe('LIVE_ENABLED - lives in every build (the production flip, owner 2026-10-30)', () => {
  it('is on for a production build, which sets nothing', async () => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', '');
    expect((await load()).LIVE_ENABLED).toBe(true);
  });

  it('is on for a dev build', async () => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', 'development');
    expect((await load()).LIVE_ENABLED).toBe(true);
  });

  it('no longer reads the deploy environment: the server kill switch is what closes lives', () => {
    // A production binary that tested `deployEnvironment()` again would draw no live whatever
    // `platform_config.lives_mode` said - the state 1.5.1 shipped in.
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'features.ts'),
      'utf8'
    );
    const expression = source.match(/export const LIVE_ENABLED = ([^;]+);/);
    expect(expression, 'LIVE_ENABLED was renamed or removed').not.toBeNull();
    expect(expression![1]).not.toMatch(/deployEnvironment/);
  });
});

describe('video follows the calls switch, and production is held by the server (1.5.2)', () => {
  // Read from the expression, because CALLS_COMPILED is a constant this suite cannot stub: video
  // must never be compiled into a binary that cannot call, and never carry a clause of its own
  // that a production build reads differently from a dev one.
  it('CALLS_VIDEO_ENABLED is CALLS_ENABLED', async () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'features.ts'),
      'utf8'
    );
    const expression = source.match(/export const CALLS_VIDEO_ENABLED = ([^;]+);/);
    expect(expression, 'CALLS_VIDEO_ENABLED was renamed or removed').not.toBeNull();
    expect(expression![1].trim()).toBe('CALLS_ENABLED');
  });
});
