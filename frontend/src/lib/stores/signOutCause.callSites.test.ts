import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * EACH SIGN-OUT EXIT PASSES ITS OWN LABEL - pinned at the source, because nothing else would notice
 * a swap. The label is never read to decide anything (`signOutCause.ts`), so the PIN gate's exit
 * passing `'chosen'` would keep every behavioural test green while the native `[PushEnd]` line went
 * back to lying about who decided - the exact misreading of the Mi 9T, 2026-11-15, where the gate's
 * "Se deconnecter" was taken for a session the server had ended.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(SRC, path), 'utf8');

/**
 * The text of `function name(` up to the next line that DECLARES a function (or the file's end) -
 * a line starting with `function`, `async function` or `export`, so a word in a comment never cuts
 * the body short.
 */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n[ \t]*(export |async function |function )/);
  return src.slice(start, next === -1 ? undefined : start + 1 + next);
}

/** Every `clearAuth('<label>')` call in a source, in order. */
function labelsIn(src: string): string[] {
  return [...src.matchAll(/clearAuth\('([a-z-]+)'\)/g)].map((m) => m[1]);
}

/** Each exit: the file, the function that signs out, and the label it must pass. */
const EXITS = [
  ['lib/components/layout/ChatBackgroundService.svelte', 'handlePinSignOut', 'pin-gate'],
  ['lib/components/shared/PlatformGateOverlay.svelte', 'handleMaintenanceLogout', 'platform-gate'],
  ['lib/components/shared/IdentitySplitOverlay.svelte', 'handleSignOut', 'identity-split'],
  ['lib/components/settings/SettingsDangerZone.svelte', 'handleDeleteAccount', 'account-deleted'],
  ['lib/composables/session/sessionAuth.ts', 'runRevokedDeviceWipe', 'device-revoked'],
  ['lib/stores/auth.ts', 'signOutByChoice', 'chosen'],
] as const;

describe('every sign-out exit names itself', () => {
  for (const [file, fn, label] of EXITS) {
    it(`${fn} passes '${label}'`, () => {
      expect(labelsIn(fnBody(read(file), fn))).toEqual([label]);
    });
  }

  it('no file signs out with a label this table does not pin', () => {
    for (const file of new Set(EXITS.map(([f]) => f))) {
      const pinned = EXITS.filter(([f]) => f === file).map(([, , l]) => l);
      expect(labelsIn(read(file)).sort(), file).toEqual([...pinned].sort());
    }
  });

  it("a dead session signs out as 'session-expired', through the shell's clearAuth", () => {
    expect(read('lib/composables/session/endExpiredSession.ts')).toContain(
      "deps.signOut('session-expired')"
    );
    expect(
      fnBody(read('lib/components/layout/ChatBackgroundService.svelte'), 'handleSessionExpired')
    ).toContain('signOut: clearAuth,');
  });
});

describe('the native log knows the same causes', () => {
  it('maps exactly the labels of the TypeScript union, and nothing else, to themselves', () => {
    const union = [...read('lib/stores/signOutCause.ts').matchAll(/^\s*\| '([a-z-]+)'/gm)].map(
      (m) => m[1]
    );
    const rust = read('../src-tauri/src/commands/push_registration.rs');
    const start = rust.indexOf('fn sign_out_cause_label(');
    expect(start).toBeGreaterThan(-1);
    const body = rust.slice(start, rust.indexOf('\n}', start));
    const arms = [...body.matchAll(/"([a-z-]+)" => "([a-z-]+)"/g)];
    expect(arms.every(([, from, to]) => from === to)).toBe(true);
    expect(arms.map(([, from]) => from).sort()).toEqual([...union].sort());
    expect(union.length).toBeGreaterThan(0);
  });
});
