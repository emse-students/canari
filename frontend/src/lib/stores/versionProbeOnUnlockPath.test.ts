/**
 * THE VERSION PROBE MAY BLOCK A LOGIN BUTTON. IT MAY NOT BLOCK AN UNLOCK.
 *
 * `refreshAppVersionCheck()` calls `GET /api/version` behind a retry ladder of 3 x 8 s timeouts
 * plus backoff. Awaiting it is right in exactly one place: the login button, where a client below
 * `minClientVersion` must be refused before a round trip to Authentik, and where the press has
 * already raised a spinner that says so (see docs/wiki/frontend/modules/auth.md).
 *
 * On the unlock path it was pure cost. `mayPromptForPin` awaited it before the PIN keypad and the
 * BiometricPrompt, so on a degraded link the fingerprint prompt could be held back ~26 s - and then
 * answered from the cached verdict the store had ALREADY hydrated synchronously at import. The
 * await never produced the first verdict, only a newer one (Pixel 6a, 4.2-4.6 s from launch to
 * prompt, 2026-09-15).
 *
 * Nothing is weakened by reading the verdict instead of waiting for it: `PlatformGateOverlay` is
 * mounted in the root layout and derives from the same store, so a refresh that lands on a blocking
 * answer raises the gate over whatever the session has reached. The overlay is the enforcement.
 *
 * THE ALLOWED SET IS PINNED RATHER THAN THE UNLOCK PATH SEARCHED, because the failure mode is a new
 * await appearing somewhere nobody thought of as "the unlock path". This test fails on any of them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../..');

/** `await refreshAppVersionCheck(` - a caller made to wait for the probe. */
const AWAITS_THE_PROBE = /\bawait\s+refreshAppVersionCheck\s*\(/;

/**
 * The login button, and nothing else.
 *
 * Both of its awaits are deliberate: one on the OIDC button, one on the password form. A third
 * entry here should be a decision someone wrote down, not a line that drifted in.
 */
const ALLOWED = new Set(['lib/components/auth/LoginPage.svelte']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'paraglide' || entry === 'node_modules') continue;
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|svelte)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('the version probe never sits in front of an unlock', () => {
  it('has no caller awaiting it outside the login button', () => {
    const offenders = sourceFiles(SRC)
      .map((file) => relative(SRC, file).replace(/\\/g, '/'))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => AWAITS_THE_PROBE.test(readFileSync(resolve(SRC, rel), 'utf8')));

    expect(
      offenders,
      `Call refreshAppVersionCheck() without awaiting it, and read the verdict with ` +
        `shouldBlockSessionUnlock() / isBelowMinClientVersion(). The store hydrates that verdict ` +
        `from cache at import, so the await buys a fresher answer at the price of a round trip - ` +
        `and behind its retry ladder that price is up to ~26 s in front of the user's keypad or ` +
        `fingerprint prompt. PlatformGateOverlay raises the gate on its own when the refresh lands.`
    ).toEqual([]);
  });

  it('still guards the login button, which is where waiting is correct', () => {
    // The complement of the rule above: if these awaits ever disappear, a client below
    // minClientVersion would be sent to Authentik before anything refused it.
    const loginPage = readFileSync(resolve(SRC, 'lib/components/auth/LoginPage.svelte'), 'utf8');
    expect(AWAITS_THE_PROBE.test(loginPage)).toBe(true);
  });
});
