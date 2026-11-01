import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F1 - THE ORDER THAT MAKES THE LOCAL PREVIEW SAFE, PINNED IN THE SOURCE.
 *
 * Every property below is an ORDER between statements of `loginImpl` or of the landing effect, and
 * none of them is visible to a behavioural test: the preview and the token race on a real device
 * and never in a mock. Same technique and reasoning as `startupOrder.test.ts`.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const auth = read('src/lib/composables/session/sessionAuth.ts');
const landing = read('src/lib/components/layout/ChatBackgroundService.svelte');
const page = read('src/lib/components/MainChatPage.svelte');

const loginBody = auth.slice(auth.indexOf('export async function loginImpl('));

function at(haystack: string, needle: string): number {
  const i = haystack.indexOf(needle);
  expect(i, `missing: ${needle}`).toBeGreaterThan(-1);
  return i;
}

describe('loginImpl and the landing preview', () => {
  it('starts the vault preview BEFORE the token is awaited (the decision of 2026-10-12)', () => {
    const vault = at(loginBody, 'if (isVaultLogin && !vaultOwnerUnproven) {');
    const start = at(loginBody, 'startLandingPreview(storageOpen, deviceKeyB64);');
    const token = at(loginBody, "accessToken = await untilSignedOut(getToken(), 'access-token');");
    expect(vault).toBeLessThan(start);
    expect(start).toBeLessThan(token);
  });

  it('starts the PIN preview only after pin-check proved the PIN and the device', () => {
    // `unlockWithPin` returns the device key only once pin-check answered `ok` or `registered` and
    // the `mismatch` and `resetRequired` branches were passed (`pinUnlock.test.ts`, by behaviour), so
    // the preview starting after its return is the whole of the ordering left to pin here.
    const unlock = at(loginBody, 'deviceKeyB64 = await untilSignedOut(');
    const starts = [
      ...loginBody.matchAll(/startLandingPreview\(storageOpen, deviceKeyB64\);/g),
    ].map((m) => m.index ?? -1);
    expect(starts).toHaveLength(2);
    expect(starts[1]).toBeGreaterThan(unlock);
  });

  it('removes the preview, then lets the read finish, BEFORE the revocation wipe', () => {
    const revoked = at(loginBody, 'if (revoked) {');
    const block = loginBody.slice(revoked, revoked + 900);
    const withdraw = at(block, "withdrawLandingPreview('device revoked');");
    const settle = at(block, 'if (landingPreview) await landingPreview;');
    expect(withdraw).toBeLessThan(settle);
    expect(settle).toBeLessThan(at(block, 'await wipeRevokedDevice(ctx, cb);'));
  });

  it('removes the preview on every exit without a session, and never waits on the store to do it', () => {
    for (const reason of ["'session expired'", "'identity split'", 'login did not complete']) {
      at(loginBody, `withdrawLandingPreview(${reason.startsWith("'") ? reason : '`' + reason}`);
    }
    expect(loginBody).not.toContain('await withdrawLandingPreview');
  });

  it('redirects first, withdraws second, and releases the login flag last on both early exits', () => {
    for (const [branch, first, reason] of [
      ['if (err instanceof SessionExpiredError) {', 'cb.onSessionExpired()', "'session expired'"],
      ['if (err instanceof IdentitySplitError) {', 'cb.onLoginFailed?.(', "'identity split'"],
    ]) {
      const block = loginBody.slice(at(loginBody, branch), at(loginBody, branch) + 900);
      const go = at(block, first);
      const withdraw = at(block, `withdrawLandingPreview(${reason});`);
      const release = at(block, 'releaseLoginFlag();');
      expect(go).toBeLessThan(withdraw);
      expect(withdraw).toBeLessThan(release);
    }
  });

  it('names its owner on the preview and on the discard, so an overlapping login keeps its own', () => {
    expect(loginBody).toContain('owner: loginId,');
    expect(loginBody).toContain('cb.discardLandingPreview?.(reason, loginId);');
  });

  it('lets the preview land before the seed rebuilds the map', () => {
    // The LAST wait on the preview is the session's; the first belongs to the revocation exit.
    const seed = at(loginBody, 'await cb.seedConversationRows();');
    const waits = [...loginBody.matchAll(/if \(landingPreview\) await landingPreview;/g)].map(
      (m) => m.index ?? -1
    );
    expect(waits.filter((i) => i < seed).length).toBeGreaterThan(1);
    expect(waits.every((i) => i < seed)).toBe(true);
  });

  it('registers the outbox in the same synchronous run that sets isLoggedIn (held sends rely on it)', () => {
    const between = loginBody.slice(
      at(loginBody, 'ctx.setIsLoggedIn(true);'),
      at(loginBody, 'registerOutbox(makeOutboxDeps(ctx, cb));')
    );
    // A statement of the try block itself (four spaces deep); the `void (async () => ...)()` that
    // saves the device key awaits inside its own closure, which does not suspend this function.
    expect(between).not.toMatch(/^ {4}(?:const [^=]+= |let [^=]+= )?await /m);
  });
});

describe('the landing effect before the session', () => {
  const effect = landing.slice(landing.indexOf('const id = notifNav.pending;'));
  it('selects only the preview before the session, and returns before anything that acts', () => {
    const preSession = effect.slice(
      at(effect, 'if (!sessionUp) {'),
      at(effect, 'openNotificationTarget(')
    );
    expect(preSession).toContain('globalConvs.previewSelect(displayedKey)');
    expect(preSession).not.toMatch(/loadHistoryForConversation|selectConversation\(/);
  });

  it('ends the preview when a second landing names another conversation, not only when none is pending', () => {
    const effect = landing.slice(
      at(
        landing,
        'const previewed = globalConvs.landingPreviewKey;\n    if (previewed === null || globalSession.isLoggedIn) return;'
      )
    );
    const body = effect.slice(0, at(effect, 'discardLandingPreview('));
    expect(body).toContain('if (pending === previewed) return;');
    expect(body).not.toContain('if (notifNav.pending !== null) return;');
  });
});

describe('the chat page during a local preview', () => {
  it('does not mount the conversation list, whose rows act when tapped', () => {
    const sidebar = at(page, '<Sidebar {...makeSidebarCommonProps()}');
    // Before the session it mounts ONLY for the Communities page's saved list (F1), whose taps are
    // landings and whose admin controls are withheld - never for a conversation's local preview.
    expect(page.slice(sidebar - 120, sidebar)).toContain(
      '{#if session.isLoggedIn || isWorkspacePreview}'
    );
    const preview = page.slice(at(page, 'const isWorkspacePreview = $derived('));
    expect(preview.slice(0, preview.indexOf(');'))).toContain("routeMode === 'communities'");
    expect(page).toContain('previewOnly: !session.isLoggedIn');
  });
  it('ends the landing and reports held sends when the page is left during a preview', () => {
    const destroy = page.slice(at(page, 'onDestroy(() => {'));
    const body = destroy.slice(0, destroy.indexOf('\n  });'));
    expect(body).toContain('heldSends.drop()');
    expect(body).toContain('convs.discardLandingPreview(');
    expect(body).toContain('notifNav.clear()');
  });
  it('shows the held sends while they wait', () => {
    expect(page).toContain(
      "heldNotice={heldCount > 0 ? m.chat_send_held({ count: heldCount }) : ''}"
    );
  });
  it('sends no typing frame without a session', () => {
    const typing = page.slice(at(page, 'function handleTyping('));
    expect(typing.slice(0, 300)).toContain('if (!session.isLoggedIn) return;');
  });
});
