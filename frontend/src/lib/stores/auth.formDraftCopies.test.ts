// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * EVERY sign-out erases the forms' device copies of the account that leaves (owner, 2026-11-08):
 * edits no save has landed must never be seen, nor sent, by the account signed in next. Both ways
 * out go through `clearAuthUnderway`, and the account is read BEFORE its identity is forgotten.
 */
const eraseFormDraftCopies = vi.fn(async (_userId: string | null, _why: string) => {});
vi.mock('$lib/forms/draftCopies', () => ({
  eraseFormDraftCopies: (userId: string | null, why: string) => eraseFormDraftCopies(userId, why),
}));

const user = vi.hoisted(() => ({ id: 'u-leaving' as string | null }));
vi.mock('$lib/stores/user', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/user')>()),
  currentUserId: () => user.id,
  clearUserLocally: () => {
    user.id = null;
  },
}));

const { clearAuth, clearAuthLocally } = await import('$lib/stores/auth');

beforeEach(() => {
  eraseFormDraftCopies.mockClear();
  user.id = 'u-leaving';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 }))
  );
});

describe("a sign-out erases the forms' device copies", () => {
  it('clearAuth erases those of the account that leaves, named before it is forgotten', async () => {
    await clearAuth();
    expect(eraseFormDraftCopies).toHaveBeenCalledWith('u-leaving', 'signed out');
  });

  it('clearAuthLocally erases them too', async () => {
    await clearAuthLocally();
    expect(eraseFormDraftCopies).toHaveBeenCalledWith('u-leaving', 'signed out');
  });
});
