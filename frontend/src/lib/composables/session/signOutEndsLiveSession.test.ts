import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A sign-out followed by a sign-in in the same process must reach the unlock.
 *
 * Measured on the Mi 9T, 2026-10-14, 2 of 2: Tableau de bord > Deconnexion, then sign in again. The
 * sign-out ran `clearAuth()` only, so the live session kept running (`isLoggedIn` true) and the
 * foreground resume after the sign-in browser reconnected it 1 s BEFORE the OIDC callback had its
 * token: `refresh✗latched`, `[AUTH] Session expired - redirecting to /login.`, `session→F`. The
 * callback then completed, but `_loginInProgress` - set by the earlier SUCCESSFUL unlock and released
 * by nothing on that path - turned every later trigger away: no PIN gate, no vault restore,
 * "Connexion en cours..." for four minutes.
 *
 * The behaviour of `clearAuth` calling the handler first is tested in `stores/auth.test.ts`; the
 * shell and the session run over dozens of module-level dependencies, so their two halves are
 * pinned in the source, as `logoutResetsAccountState.test.ts` does.
 */
// THROUGH A PARAMETER, NOT A LITERAL: Vite rewrites `new URL('<literal>', import.meta.url)` into a
// served `http:` asset URL, which `fileURLToPath` refuses.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const shell = read('../../components/layout/ChatBackgroundService.svelte');
const sessionAuth = read('./sessionAuth.ts');

/** The body of the function whose declaration starts with `head`, up to the next blank-line `}`. */
function body(source: string, head: string): string {
  const at = source.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  return source.slice(at, source.indexOf('\n  }\n', at) + 4);
}

describe('every sign-out ends the live session on the device', () => {
  it('the shell hands clearAuth its teardown, and takes it back on unmount', () => {
    expect(shell).toContain('setSignOutHandler(handleSignedOut);');
    expect(shell).toContain('setSignOutHandler(null);');
  });

  it('the teardown stops the session AND releases the latch the successful unlock left set', () => {
    const handler = body(shell, 'function handleSignedOut()');
    expect(handler).toContain('globalSession.endSession(sessionCb());');
    expect(handler).toContain('_loginInProgress = false;');
  });

  it('ends a live session through the shared teardown, and nothing that is not live', () => {
    const end = sessionAuth.slice(sessionAuth.indexOf('export function endSessionImpl'));
    const guard = end.indexOf('if (!ctx.isLoggedIn()) {');
    expect(guard).toBeGreaterThan(-1);
    // Before the teardown: the revocation wipe calls `clearAuth` after its own NON-flushing
    // teardown, and a second, flushing one would write back what the wipe deletes.
    expect(guard).toBeLessThan(end.indexOf("tearDownLiveSession(ctx, cb, 'logout');"));
  });
});
