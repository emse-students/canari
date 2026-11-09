import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * A build loads `kit.config.js` more than once (kit, then vite-plugin-svelte). #1476 stamped
 * `kit.version.name` at every load, so one output carried two build ids and the bundle check
 * refused it. The stamp must be computed ONCE per process: two loads, one name.
 *
 * The adapters and the preprocessor are not what is under test, and cold-importing their graphs
 * twice is what made this test the slowest in the suite (it timed out under the full run,
 * 2026-10-15). They are stubbed; the stamp and its one `git rev-parse` are the real ones.
 */
vi.mock('@sveltejs/adapter-node', () => ({ default: () => ({ name: 'adapter-node-stub' }) }));
vi.mock('@sveltejs/adapter-static', () => ({ default: () => ({ name: 'adapter-static-stub' }) }));
vi.mock('@sveltejs/vite-plugin-svelte', () => ({ vitePreprocess: () => ({}) }));

describe('kit.config.js build stamp', () => {
  afterEach(() => vi.useRealTimers());
  it('is the same name on every load within one process, in the <ms>-<sha9> shape', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const url = pathToFileURL(resolve(__dirname, '../kit.config.js')).href;
    const first = (await import(/* @vite-ignore */ `${url}?load=1`)).default.version.name;
    // The stamp leads with a millisecond clock: step it, so a per-load stamp would differ.
    vi.advanceTimersByTime(5);
    const second = (await import(/* @vite-ignore */ `${url}?load=2`)).default.version.name;
    expect(first).toMatch(/^\d+-[0-9a-f]{9}$/);
    expect(second).toBe(first);
  });
});
