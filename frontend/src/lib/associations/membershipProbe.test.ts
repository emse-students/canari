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
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ensureMyAssociations(true)).resolves.toEqual([]);

    expect(flags.superAdmin).toEqual([false]);
    expect(flags.moderator).toEqual([false]);
    expect(flags.validator).toEqual([false]);
    // A silently empty membership list is indistinguishable from a user who belongs to nothing.
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
