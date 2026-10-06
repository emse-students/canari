import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * A build loads `svelte.config.js` more than once (kit, then vite-plugin-svelte). #1476 stamped
 * `kit.version.name` at every load, so one output carried two build ids and the bundle check
 * refused it. The stamp must be computed ONCE per process: two loads, one name.
 */
describe('svelte.config.js build stamp', () => {
  it('is the same name on every load within one process, in the <ms>-<sha9> shape', async () => {
    const url = pathToFileURL(resolve(__dirname, '../svelte.config.js')).href;
    const first = (await import(/* @vite-ignore */ `${url}?load=1`)).default.kit.version.name;
    await new Promise((r) => setTimeout(r, 5));
    const second = (await import(/* @vite-ignore */ `${url}?load=2`)).default.kit.version.name;
    expect(first).toMatch(/^\d+-[0-9a-f]{9}$/);
    expect(second).toBe(first);
  });
});
