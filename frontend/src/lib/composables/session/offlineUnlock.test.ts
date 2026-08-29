import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Source guards on the two decisions `sessionAuth` makes that no unit test can execute: which
 * logins may unlock without a server, and what a session stops before it erases itself.
 *
 * The behaviour itself is not executable in a unit test - `loginImpl` is a several-hundred-line
 * flow over a dozen module-level dependencies (MLS init, storage, push, outbox, WebSocket), and a
 * harness faking all of them would assert its own mocks. What matters here is smaller and exactly
 * the kind of thing a source guard pins well: WHICH paths are allowed to unlock without a server,
 * and that a server answer is never mistaken for a missing network. Both are security decisions
 * that a later edit could reverse while every other test stays green.
 *
 * The same argument covers the revocation teardown at the bottom of this file: `wipeRevokedDevice`
 * runs over the same dozen module-level dependencies, and what broke was an ORDER, which is what a
 * source guard pins best.
 *
 * See `sessionDeviceKey.test.ts` for the same technique on the Tauri command contract.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const sessionAuth = read('./sessionAuth.ts');

/** The body of an exported function, from its signature to the start of the next one. */
const bodyOf = (signature: string) => {
  const start = sessionAuth.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const rest = sessionAuth.slice(start + 1);
  const end = rest.indexOf('\nexport ');
  return rest.slice(0, end === -1 ? undefined : end);
};

const loginImplBody = bodyOf('export async function loginImpl');
const tearDownBody = bodyOf('export function tearDownLiveSession');
const wipeRevokedDeviceBody = bodyOf('export async function wipeRevokedDevice');

describe('which logins may unlock offline', () => {
  it('allows exactly the two paths that already skip the server PIN check when online', () => {
    // This single line is the whole security argument. `isBiometric` is authenticated by the
    // platform keystore and `isVaultLogin` by the encrypted device-key vault, so neither asks the
    // server anything about the PIN even with a network - unlocking them offline therefore
    // verifies everything it verifies online.
    expect(loginImplBody).toMatch(/const offlineCapable = isBiometric \|\| isVaultLogin;/);
  });

  it('never lets the PIN path unlock offline', () => {
    // The PIN's at-rest key derives from a server-issued salt. Caching that salt to make the PIN
    // work offline is what would turn a 4-character secret into an offline-bruteforceable one, so
    // the salt must stay a live fetch and the PIN path must keep refusing without a network.
    const branchStart = loginImplBody.indexOf('if (offlineCapable) {');
    const branchEnd = loginImplBody.indexOf('// The PIN path genuinely cannot continue');
    // Without these two, the slice below would be empty and every `not.toContain` would pass
    // vacuously - the failure mode that makes a source guard worthless.
    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);

    const offlineBranch = loginImplBody.slice(branchStart, branchEnd);
    expect(offlineBranch).not.toContain('pin-salt');
    expect(offlineBranch).not.toContain('deriveDeviceKeyB64');
    expect(offlineBranch).not.toContain('computePinVerifier');

    // And the salt is never persisted anywhere, on any path.
    expect(sessionAuth).not.toMatch(/localStorage\.setItem\([^)]*salt/i);
    expect(sessionAuth).not.toMatch(/sessionStorage\.setItem\([^)]*salt/i);
  });

  it('still refuses the PIN path with a retryable error rather than a session loss', () => {
    expect(loginImplBody).toContain('m.auth_server_unreachable()');
  });
});

describe('a server answer is never read as a missing network', () => {
  it('returns on SessionExpiredError before the offline branch can run', () => {
    const catchStart = loginImplBody.indexOf('accessToken = await getToken();');
    const catchEnd = loginImplBody.indexOf('// Collect the MLS state');
    expect(catchStart).toBeGreaterThan(-1);
    expect(catchEnd).toBeGreaterThan(catchStart);

    const catchBlock = loginImplBody.slice(catchStart, catchEnd);
    const expiredAt = catchBlock.indexOf('err instanceof SessionExpiredError');
    const offlineAt = catchBlock.indexOf('if (offlineCapable)');

    expect(expiredAt).toBeGreaterThan(-1);
    expect(offlineAt).toBeGreaterThan(-1);
    // A 401/403 means the server was reached and refused us - the one case that must never be
    // papered over as "no network". Order is the guarantee: the expired branch returns first.
    expect(expiredAt).toBeLessThan(offlineAt);
    expect(catchBlock.slice(expiredAt, offlineAt)).toContain('return;');
  });
});

describe('the offline session never re-enters the destructive catch', () => {
  it('guards the post-init getToken instead of calling it unconditionally', () => {
    // This call sits inside the try whose catch runs resetMls() + clearUserLocally() +
    // clearDeviceKey(). Letting it throw offline would destroy the session that just unlocked.
    expect(loginImplBody).toMatch(
      /ctx\.setAuthToken\(offlineSession \? '' : await getToken\(\)\);/
    );
    expect(loginImplBody).toContain('ctx.setIsOfflineSession(offlineSession);');
  });

  it('skips the connection, push registration and watchdogs while offline', () => {
    // The connection watchdog is the harmful one: left running it would burn the reconnect budget
    // against an absent network and leave the circuit OPEN, so regaining signal would land the
    // user on a "Retry" button instead of a working app.
    expect(loginImplBody).toContain(
      '[INIT] Offline session - gateway connection deferred until the network returns.'
    );
    expect(loginImplBody).toContain('[PUSH] Registration deferred - offline session.');

    const tailStart = loginImplBody.indexOf('if (!getIsTabLeader()) return;');
    expect(tailStart).toBeGreaterThan(-1);
    const tail = loginImplBody.slice(tailStart);
    const guardAt = tail.indexOf('if (offlineSession) return;');
    expect(guardAt).toBeGreaterThan(-1);
    expect(tail).toContain('startConnectionWatchdogImpl(ctx, cb)');
    expect(tail).toContain('startSyncWatchdogImpl(ctx, cb)');
    expect(tail).toContain('runGroupDiscoveryImpl(ctx, cb');
    expect(guardAt).toBeLessThan(tail.indexOf('startConnectionWatchdogImpl(ctx, cb)'));
    expect(guardAt).toBeLessThan(tail.indexOf('startSyncWatchdogImpl(ctx, cb)'));
    expect(guardAt).toBeLessThan(tail.indexOf('runGroupDiscoveryImpl(ctx, cb'));
  });

  it('holds the outbox until a token exists', () => {
    // The outbox flushes on its own `online` listener, which fires before the promotion has a
    // token; without this predicate every queued entry burns an attempt on that first tick.
    expect(sessionAuth).toContain('canFlush: () => !ctx.isOfflineSession(),');
  });

  it('detaches the reconnect listener on logout', () => {
    // Now via the shared teardown, which is the point: the listener is detached for BOTH exits.
    const logout = sessionAuth.slice(sessionAuth.indexOf('export function logoutImpl'));
    expect(logout).toContain("tearDownLiveSession(ctx, cb, 'logout');");
    expect(tearDownBody).toContain('unregisterOfflinePromotion();');
  });
});

/**
 * A wipe is not a wipe while something is still running that can put the state back.
 *
 * Measured on prod 2026-08-28: 1.25 s after a revoked device wiped itself, the SYNC_WATCHDOG ticked,
 * found ten conversations still in memory and an empty WASM, and drove `requestReAdd` for all ten -
 * re-marking every group not-ready and rebuilding the MLS database through `ensureMls()`, which
 * creates a client whenever it finds none. `logoutImpl` had always stopped all of that; the
 * revocation path had never run any of it. These pin the two halves that cannot drift again.
 */
describe('what a revoked device stops before it deletes anything', () => {
  it('stops the live session before the first delete', () => {
    const wipe = wipeRevokedDeviceBody;
    const stop = wipe.indexOf("tearDownLiveSession(ctx, cb, 'revoked');");
    expect(stop).toBeGreaterThan(-1);
    // Every erasure must come after it - one running timer is enough to undo all three.
    for (const erase of ['resetDeviceAsFreshImpl(', 'clearAuth()', 'wipeDeviceToFactory()']) {
      expect(wipe.indexOf(erase)).toBeGreaterThan(stop);
    }
  });

  it('stops the watchdog that re-created the state, and empties what it iterates', () => {
    // The timer AND its candidate set: the watchdog unions the live conversation map with the
    // not-ready registry, so clearing the timer alone would still leave a reactive path a source.
    expect(tearDownBody).toContain('clearInterval(ctx.timers.syncWatchdog);');
    expect(tearDownBody).toContain('cb.conversations.clear();');
  });

  it('never flushes MLS state on the way out of a revocation', () => {
    // The flush writes back exactly what the wipe exists to delete, so it is gated on the reason
    // rather than shared - and the persister is still uninstalled either way.
    const flushAt = tearDownBody.indexOf('flushActiveMlsStateEncrypted()');
    expect(flushAt).toBeGreaterThan(-1);
    const guard = tearDownBody.lastIndexOf("if (reason === 'logout') {", flushAt);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(flushAt);
    expect(tearDownBody).toContain('unregisterMlsStatePersister();');
  });
});

/**
 * The wipe's own first act is what let a login start and undo it.
 *
 * Measured on prod 2026-08-29: a `device_revoked` frame arrived, `wipeRevokedDevice` began, and 3 ms
 * later a login started - because `tearDownLiveSession` had set `isLoggedIn` false, and that is one
 * of the flags `loginImpl` reads to decide nobody owns the flow. The login's own revocation check
 * could not be answered (the wipe had already killed the session) so it read "not revoked", and it
 * reopened `CanariDB_<userId>` 24 ms before the delete. `deleteDatabase` does not fail on an open
 * connection, it BLOCKS: the store SURVIVED on a device its owner had declared lost.
 *
 * A latch over the WHOLE wipe, not a device id: between clearing `mls_device_id_<userId>` and
 * deleting the stores there is a window in which no identity exists to recognise. The ORDER is the
 * fix and the order is what these pin.
 */
describe('a login can never race the wipe that erases it', () => {
  it('raises the latch BEFORE the teardown that clears isLoggedIn', () => {
    const wipe = wipeRevokedDeviceBody;
    const latch = wipe.indexOf('ctx.setWipingRevokedDevice(true);');
    expect(latch).toBeGreaterThan(-1);
    // Strictly before the teardown - raising it afterwards leaves exactly the gap that was measured.
    expect(wipe.indexOf("tearDownLiveSession(ctx, cb, 'revoked');")).toBeGreaterThan(latch);
  });

  it('releases the latch in a finally, so a failed wipe cannot lock a real user out', () => {
    expect(wipeRevokedDeviceBody).toMatch(
      /finally\s*\{\s*ctx\.setWipingRevokedDevice\(false\);\s*\}/
    );
  });

  it('makes loginImpl refuse while the latch is up, and say which flag won', () => {
    // The guard is only worth having if it is read where a login decides to proceed, and only
    // debuggable if the log names it - the other three are named for exactly that reason.
    expect(loginImplBody).toContain('ctx.isWipingRevokedDevice()');
    expect(loginImplBody).toContain('wipingRevokedDevice=${ctx.isWipingRevokedDevice()}');
  });
});

/**
 * What a revoked LIVE device is handed to when the wipe is done.
 *
 * The two login-path call sites throw a `LoginFailure`, which is right: a person is standing at
 * the gate and the modal is where the answer belongs. The push handler is the third site and it
 * used the same seam, which was wrong for a reason the callbacks make concrete - the background
 * service binds `onLoginFailed` to the saved-PIN handler, so a revocation REOPENED THE PIN PROMPT
 * on a device the line above had just returned to a fresh install. There was no PIN to enter, no
 * device id and no session; measured on prod 2026-08-29 the client simply sat on /chat with no
 * sidebar until the prompt drew a 401 of its own.
 *
 * `onSessionExpired` is the seam for an authentication loss, and the one the background service
 * wires unconditionally. These pin the choice, not the wording.
 */
describe('a revoked live device is logged out, not asked for its PIN', () => {
  /** The push handler from the line that announces the revocation to the next registration. */
  const liveRevocationTail = (() => {
    const at = loginImplBody.indexOf('[SECURITY] This device was revoked by its owner');
    expect(at).toBeGreaterThan(-1);
    const end = loginImplBody.indexOf('onWelcomeRequest', at);
    expect(end).toBeGreaterThan(at);
    return loginImplBody.slice(at, end);
  })();

  it('wipes first, then hands over to the session-expired seam', () => {
    const wipe = liveRevocationTail.indexOf('await wipeRevokedDevice(ctx, cb);');
    expect(wipe).toBeGreaterThan(-1);
    // The order is the point: handing over before the wipe would navigate away from the device
    // being erased, and nothing would finish erasing it.
    expect(liveRevocationTail.indexOf('cb.onSessionExpired?.();')).toBeGreaterThan(wipe);
  });

  it('never reopens the PIN prompt for a device that no longer has one', () => {
    // THE CALL, NOT THE NAME - the comment above the fix names the seam it replaced, on purpose,
    // and a guard that cannot tell an explanation from a call site fails on its own documentation.
    expect(liveRevocationTail).not.toContain('cb.onLoginFailed?.(');
  });
});
