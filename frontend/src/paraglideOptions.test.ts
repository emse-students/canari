/**
 * THE CLI AND THE VITE PLUGIN WRITE THE SAME FOLDER, SO THEY MUST NOT CARRY OPTIONS OF THEIR OWN.
 *
 * Two sets of options meant two different outputs in `src/lib/paraglide`, and each CLI compile
 * invalidated the plugin's cache: the next `vite dev` rewrote ~4,500 files before it listened
 * (222 s). `project.inlang/paraglide.config.js` is the one source both read; this fails the day an
 * option reappears next to either call. See docs/wiki/frontend/architecture.md (two writers).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('the Paraglide compiler options', () => {
  it('live in the shared config file, with the structure the CLI forces', async () => {
    const config = (await import('../project.inlang/paraglide.config.js')).default;
    // The CLI always passes `message-modules` unless a flag says otherwise, so a config value that
    // differs would reach the plugin only - the exact drift this test exists to stop.
    expect(config.outputStructure).toBe('message-modules');
    expect(config.strategy).toEqual(['localStorage', 'preferredLanguage', 'baseLocale']);
    expect(config.isServer).toContain('import.meta.env');
  });

  it('are not restated in the vite plugin call', () => {
    const call = /paraglideVitePlugin\(\{([\s\S]*?)\}\)/.exec(read('vite.config.js'))?.[1] ?? '';
    expect(call).toContain('project:');
    expect(call).not.toMatch(/strategy|isServer|outputStructure/);
  });

  it('are not restated in the CLI script that writes the app output', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts['paraglide:compile']).not.toMatch(/--strategy|--is-server|--output-structure/);
  });
});
