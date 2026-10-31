import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every call that starts the push service passes the delivery service's own base URL, and nothing
 * stands behind it. The root layout used to pass `historyBaseUrl || DEFAULT_PUBLIC_APP_ORIGIN`:
 * `historyBaseUrl` is never empty, so the production origin was dead code - and a fallback that
 * could only ever have sent a dev or local build's push registration to production.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const CALLERS = {
  layout: read('../../routes/+layout.svelte'),
  sessionAuth: read('../composables/session/sessionAuth.ts'),
  promoteOfflineSession: read('../composables/session/promoteOfflineSession.ts'),
};

/** The first argument of every `startPushService(...)` call in `source`. */
function firstArguments(source: string): string[] {
  return [...source.matchAll(/startPushService\(\s*([^,]+),/g)].map((m) =>
    m[1].replace(/\s+/g, ' ').trim()
  );
}

describe('the push service base URL', () => {
  for (const [name, source] of Object.entries(CALLERS)) {
    it(`${name} passes the delivery base URL with no fallback`, () => {
      const args = firstArguments(source.replace(/^\s*\/\/.*$/gm, ''));
      expect(args.length).toBeGreaterThan(0);
      for (const arg of args) {
        expect(arg).toMatch(/historyBaseUrl|getHistoryBaseUrl\(\)/);
        expect(arg).not.toMatch(/\|\||\?\?/);
      }
    });
  }

  it('the root layout no longer names the production origin', () => {
    expect(CALLERS.layout).not.toContain('DEFAULT_PUBLIC_APP_ORIGIN');
  });
});
