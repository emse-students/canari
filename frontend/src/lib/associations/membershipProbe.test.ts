import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ONE PROBE PUBLISHES EVERY BDE-DERIVED FLAG, INCLUDING ON THE FAILURE PATH.
 *
 * `ensureMyAssociations` loads the caller's memberships once per session and sets three reactive
 * flags from that single answer. The hazard is not the predicate - `permissions.test.ts` already
 * holds `holdsBdeFlag` to the rule that a BDE-only flag granted elsewhere is inert - it is that a
 * FOURTH flag added later gets its `set*` call in the success branch and not in the `catch`.
 *
 * A flag left at its previous value after a failed probe is worse than a denied one: the screen
 * offers a control the API will refuse, with nothing in the log to say the membership list never
 * arrived. So both branches are asserted, and the failure branch is asserted to DENY rather than
 * to leave alone.
 */

const request = vi.fn();

vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: (...args: unknown[]) => request(...args),
}));
vi.mock('$lib/stores/auth', () => ({ getToken: () => 'tok' }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: (p: string) => p, socialUrl: (p: string) => p }));
vi.mock('$lib/utils/fileDownload', () => ({ downloadDecryptedFile: vi.fn() }));

/** The reconnect listeners the module registered, fired by hand: no real connectivity, no clock. */
const reconnectListeners = new Set<() => void>();
vi.mock('$lib/stores/connectivity.svelte', () => ({
  connectivity: {
    onReconnect: (l: () => void) => {
      reconnectListeners.add(l);
      return () => reconnectListeners.delete(l);
    },
  },
}));
const fireReconnect = () => [...reconnectListeners].forEach((l) => l());
/** Lets the retry the reconnect started (a promise chain, no timer) settle. */
const settle = () => new Promise<void>((r) => setImmediate(r));

const flags = {
  superAdmin: [] as boolean[],
  moderator: [] as boolean[],
  validator: [] as boolean[],
};
vi.mock('$lib/stores/userState.svelte', () => ({
  setAssociationSuperAdmin: (v: boolean) => flags.superAdmin.push(v),
  setContentModerator: (v: boolean) => flags.moderator.push(v),
  setEventValidator: (v: boolean) => flags.validator.push(v),
}));

/** `request` reads the body as TEXT and parses it itself, so a `json()` stub is never called. */
function ok(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}

/** Re-imports the module so its session cache starts empty for each case. */
async function freshApi() {
  vi.resetModules();
  return import('./api');
}

/**
 * THE FIRST `import('./api')` TRANSFORMS THE WHOLE `api.ts` GRAPH, and it used to happen INSIDE the
 * first case: ~0.8 s alone, over the 5 s case timeout when the whole folder runs in parallel and the
 * workers fight for the CPU (measured 2026-10-26; the mocks answer at once, nothing waits on I/O).
 * The case that timed out kept running, so its late flag pushes landed in the NEXT case's arrays -
 * which is why a third, unrelated assertion failed with it. The transform is paid here, once, under
 * a timeout that names it; every case then re-EVALUATES from the transform cache in tens of ms.
 */
beforeAll(async () => {
  await import('./api');
}, 60_000);

beforeEach(() => {
  request.mockReset();
  reconnectListeners.clear();
  flags.superAdmin = [];
  flags.moderator = [];
  flags.validator = [];
});

describe('ensureMyAssociations', () => {
  it('publishes all three tiers from the one answer', async () => {
    const { ensureMyAssociations, AssociationPermissionFlag } = await freshApi();
    const { MANAGE_ASSO, MODERATE, VALIDATE_EVENTS } = AssociationPermissionFlag;
    request.mockResolvedValue(
      ok([{ id: 'bde', isBDE: true, permissions: MANAGE_ASSO | MODERATE | VALIDATE_EVENTS }])
    );

    await ensureMyAssociations(true);

    expect(flags.superAdmin).toEqual([true]);
    expect(flags.moderator).toEqual([true]);
    expect(flags.validator).toEqual([true]);
  });

  it('denies a tier the memberships do not carry', async () => {
    const { ensureMyAssociations, AssociationPermissionFlag } = await freshApi();
    request.mockResolvedValue(
      ok([{ id: 'bde', isBDE: true, permissions: AssociationPermissionFlag.MANAGE_ASSO }])
    );

    await ensureMyAssociations(true);

    expect(flags.superAdmin).toEqual([true]);
    expect(flags.validator).toEqual([false]);
  });

  it('ignores VALIDATE_EVENTS held outside a BDE association, as the server does', async () => {
    const { ensureMyAssociations, AssociationPermissionFlag } = await freshApi();
    request.mockResolvedValue(
      ok([{ id: 'club', isBDE: false, permissions: AssociationPermissionFlag.VALIDATE_EVENTS }])
    );

    await ensureMyAssociations(true);

    expect(flags.validator).toEqual([false]);
  });

  it('denies every tier when the probe fails, rather than leaving them as they were', async () => {
    const { ensureMyAssociations } = await freshApi();
    request.mockRejectedValue(new Error('offline'));
    const err = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(ensureMyAssociations(true)).resolves.toEqual([]);

    expect(flags.superAdmin).toEqual([false]);
    expect(flags.moderator).toEqual([false]);
    expect(flags.validator).toEqual([false]);
    // A silently empty membership list is indistinguishable from a user who belongs to nothing,
    // so the failure is logged at WARN with its status.
    expect(err).toHaveBeenCalledWith(expect.stringContaining('no answer'), expect.any(Error));
    err.mockRestore();
  });

  it('does not cache a failure as an answer: it is a state, and a reconnect retries it once', async () => {
    const { ensureMyAssociations, didMyAssociationsProbeFail, AssociationPermissionFlag } =
      await freshApi();
    request.mockRejectedValueOnce(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(ensureMyAssociations(true)).resolves.toEqual([]);
    expect(didMyAssociationsProbeFail()).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(reconnectListeners.size).toBe(1);
    // Callers meanwhile do not each re-ask a server that just refused.
    await ensureMyAssociations();
    expect(request).toHaveBeenCalledTimes(1);

    request.mockResolvedValue(
      ok([{ id: 'a', isBDE: true, permissions: AssociationPermissionFlag.MODERATE }])
    );
    fireReconnect();
    await settle();

    expect(request).toHaveBeenCalledTimes(2);
    expect(didMyAssociationsProbeFail()).toBe(false);
    expect(flags.moderator.at(-1)).toBe(true);
    expect(reconnectListeners.size).toBe(0);
    warn.mockRestore();
  });

  it('retries a failed probe on the next navigation, once, and not when it did not fail', async () => {
    const { ensureMyAssociations, retryFailedMyAssociationsProbe, didMyAssociationsProbeFail } =
      await freshApi();
    request.mockResolvedValueOnce(ok([]));
    await ensureMyAssociations(true);
    await retryFailedMyAssociationsProbe();
    expect(request).toHaveBeenCalledTimes(1);

    request.mockReset();
    request.mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await ensureMyAssociations(true);
    expect(didMyAssociationsProbeFail()).toBe(true);

    request.mockResolvedValue(ok([]));
    await Promise.all([retryFailedMyAssociationsProbe(), retryFailedMyAssociationsProbe()]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(didMyAssociationsProbeFail()).toBe(false);
  });

  it('a retry that fails again stays failed and is armed again', async () => {
    const { ensureMyAssociations, retryFailedMyAssociationsProbe, didMyAssociationsProbeFail } =
      await freshApi();
    request.mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await ensureMyAssociations(true);
    await retryFailedMyAssociationsProbe();
    expect(didMyAssociationsProbeFail()).toBe(true);
    expect(reconnectListeners.size).toBe(1);
  });
});
