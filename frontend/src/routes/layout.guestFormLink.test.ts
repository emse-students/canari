// @vitest-environment happy-dom
/**
 * A SIGNED-OUT VISITOR ON `/forms/<id>` (a link already in circulation for a public form) reaches
 * the guest page `/f/<id>`; a form that is not public sends them to login as before; a signed-in
 * member is never asked anything.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '3f2b8c1e-7a44-4d0e-9a51-0c6d2e8b9f10';
const user = vi.hoisted(() => ({ id: null as string | null }));
const getPublicForm = vi.hoisted(() => vi.fn());
const goto = vi.hoisted(() => vi.fn(async () => {}));
const boot = vi.hoisted(() => ({ start: vi.fn() }));

vi.mock('$lib/stores/user', () => ({ currentUserId: () => user.id }));
vi.mock('$lib/stores/auth', () => ({ refresh: vi.fn() }));
vi.mock('$lib/utils/sessionProfileCheck', () => ({ checkSessionUserInBackground: vi.fn() }));
vi.mock('$lib/stores/bootSession.svelte', () => ({
  startBootSession: boot.start,
  settleBootSession: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => (p.startsWith('/') ? p : `/${p}`) }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: { isLoggedIn: false, isLoginInProgress: false },
}));
vi.mock('$lib/forms/api', () => ({ getPublicForm }));

import { load } from './+layout';

/** Runs the root load on the path and fires the boot's "no session" callback. */
async function noSessionOutcome(path: string) {
  await load({ url: new URL(`http://x.test${path}`), fetch } as never);
  const deps = boot.start.mock.calls.at(-1)![0] as { goToLogin: () => Promise<unknown> };
  await deps.goToLogin();
}

beforeEach(() => {
  user.id = null;
  vi.clearAllMocks();
});

describe('root guard on a form member link, signed out', () => {
  it('goes to the guest page when the form is public', async () => {
    getPublicForm.mockResolvedValue({ id: ID });
    await noSessionOutcome(`/forms/${ID}`);
    expect(goto).toHaveBeenCalledWith(`/f/${ID}`, { replace: true });
  });

  it('goes to login, carrying the page, when the form is not public', async () => {
    getPublicForm.mockRejectedValue(new Error('404'));
    await noSessionOutcome(`/forms/${ID}`);
    expect(goto).toHaveBeenCalledWith(`/login?returnTo=${encodeURIComponent(`/forms/${ID}`)}`, {
      replace: true,
    });
  });

  it('asks nothing and goes to login on another page', async () => {
    await noSessionOutcome('/forms/create');
    expect(getPublicForm).not.toHaveBeenCalled();
    expect(goto).toHaveBeenCalledWith(`/login?returnTo=${encodeURIComponent('/forms/create')}`, {
      replace: true,
    });
  });

  it('never asks a signed-in member anything', async () => {
    user.id = 'u1';
    await load({ url: new URL(`http://x.test/forms/${ID}`), fetch } as never);
    expect(getPublicForm).not.toHaveBeenCalled();
    expect(boot.start).not.toHaveBeenCalled();
  });
});
