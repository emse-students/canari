import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Guards on the offline-unlock decision inside `loginImpl`.
 *
 * The behaviour itself is not executable in a unit test - `loginImpl` is a several-hundred-line
 * flow over a dozen module-level dependencies (MLS init, storage, push, outbox, WebSocket), and a
 * harness faking all of them would assert its own mocks. What matters here is smaller and exactly
 * the kind of thing a source guard pins well: WHICH paths are allowed to unlock without a server,
 * and that a server answer is never mistaken for a missing network. Both are security decisions
 * that a later edit could reverse while every other test stays green.
 *
 * See `sessionDeviceKey.test.ts` for the same technique on the Tauri command contract.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const sessionAuth = read('./sessionAuth.ts');

/** The body of `loginImpl`, from its signature to the start of the next exported function. */
const loginImplBody = (() => {
  const start = sessionAuth.indexOf('export async function loginImpl');
  expect(start).toBeGreaterThan(-1);
  const rest = sessionAuth.slice(start + 1);
  const end = rest.indexOf('\nexport ');
  return rest.slice(0, end === -1 ? undefined : end);
})();

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
    const logout = sessionAuth.slice(sessionAuth.indexOf('export function logoutImpl'));
    expect(logout).toContain('unregisterOfflinePromotion();');
  });
});
