/**
 * OPENING ADMINER FROM THE APP (user, 2026-10-02: *"add an adminer route to canari, in a safe way"*).
 *
 * Pinned: the request is a POST to core-service's `adminer-session`; its 404 and 403 are TYPED errors
 * (the page words them, nobody reads a message); the tab is opened in the click's own turn - before
 * the request - because a window opened after an `await` is dropped by a popup blocker, and it is
 * closed again when the session could not be opened, so a failure never leaves a blank tab behind.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://core.test' }));

import {
  ADMINER_PATH,
  AdminerForbiddenError,
  AdminerUnavailableError,
  openAdminer,
  openAdminerSession,
} from './adminerSession';

const answer = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

/** A tab double: records what the app does to it. */
function fakeTab() {
  return { close: vi.fn(), opener: {} as unknown, location: { href: 'about:blank' } };
}

beforeEach(() => {
  apiFetch.mockReset();
  vi.restoreAllMocks();
});

describe('openAdminerSession', () => {
  it('POSTs to the session route and returns its length', async () => {
    apiFetch.mockResolvedValue(answer(200, { expiresInSeconds: 900 }));
    expect(await openAdminerSession()).toBe(900);
    expect(apiFetch).toHaveBeenCalledWith('https://core.test/api/auth/adminer-session', {
      method: 'POST',
    });
  });

  it('types a 404 as "not offered here" and a 403 as "not an admin"', async () => {
    apiFetch.mockResolvedValue(answer(404));
    await expect(openAdminerSession()).rejects.toBeInstanceOf(AdminerUnavailableError);
    apiFetch.mockResolvedValue(answer(403));
    await expect(openAdminerSession()).rejects.toBeInstanceOf(AdminerForbiddenError);
  });

  it('leaves any other refusal a plain error', async () => {
    apiFetch.mockResolvedValue(answer(500));
    const err = await openAdminerSession().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AdminerUnavailableError);
    expect(err).not.toBeInstanceOf(AdminerForbiddenError);
  });
});

describe('openAdminer', () => {
  it('opens the tab BEFORE the request, then points it at Adminer and cuts the opener link', async () => {
    const tab = fakeTab();
    const order: string[] = [];
    vi.spyOn(window, 'open').mockImplementation(() => {
      order.push('open');
      return tab as unknown as Window;
    });
    apiFetch.mockImplementation(async () => {
      order.push('request');
      return answer(200, { expiresInSeconds: 900 });
    });

    await openAdminer();

    expect(order).toEqual(['open', 'request']);
    expect(tab.location.href).toBe(ADMINER_PATH);
    expect(tab.opener).toBeNull();
    expect(tab.close).not.toHaveBeenCalled();
  });

  it('closes the tab again, and rethrows, when the session could not be opened', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    apiFetch.mockResolvedValue(answer(403));

    await expect(openAdminer()).rejects.toBeInstanceOf(AdminerForbiddenError);

    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe('about:blank');
  });

  it('goes there in this tab when popups are blocked, rather than do nothing', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ assign } as unknown as Location);
    apiFetch.mockResolvedValue(answer(200, { expiresInSeconds: 900 }));

    await openAdminer();

    expect(assign).toHaveBeenCalledWith(ADMINER_PATH);
  });
});
