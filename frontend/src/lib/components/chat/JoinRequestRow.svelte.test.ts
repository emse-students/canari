// @vitest-environment happy-dom
/**
 * THE ASK OF A NEW PERSON, AT THE END OF THE THREAD IT IS ABOUT.
 *
 * A card that follows the store rather than a stored row: it shows only the asks of ITS
 * conversation, only while something can answer them, and it leaves with the ask - so a member never
 * sees Add and Decline for someone another member already admitted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));
// `resolveUserDisplayName` answers nothing by default, so the synchronous name stays on screen.
const resolveName = vi.hoisted(() => vi.fn(async (_id: string): Promise<string | null> => null));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `Name(${id})`,
  resolveUserDisplayName: resolveName,
}));

import JoinRequestRow from './JoinRequestRow.svelte';
import {
  raiseJoinRequest,
  resetJoinRequests,
  setJoinRequestHandlers,
} from '$lib/utils/chat/joinRequests.svelte';
import { showToast } from '$lib/stores/toast.svelte';

const ask = (userId: string, groupId = 'g1', deviceId = 'd1') => ({
  groupId,
  requesterUserId: userId,
  requesterDeviceId: deviceId,
});

let target: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

function render(groupId = 'g1') {
  app = mount(JoinRequestRow, { target, props: { groupId } });
  flushSync();
}

const button = (label: string) =>
  [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as
    | HTMLButtonElement
    | undefined;

beforeEach(() => {
  target = document.createElement('div');
  document.body.appendChild(target);
  resetJoinRequests();
  vi.mocked(showToast).mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  if (app) unmount(app);
  app = null;
  target.remove();
  setJoinRequestHandlers(null);
  vi.restoreAllMocks();
});

describe('JoinRequestRow', () => {
  it('draws the ask of its own conversation, with both answers', () => {
    setJoinRequestHandlers({ approve: vi.fn(), decline: vi.fn() });
    raiseJoinRequest(ask('carol'));
    render();

    expect(target.querySelector('[data-join-request="carol"]')).not.toBeNull();
    expect(target.textContent).toContain('Name(carol)');
    expect(button('Accepter') ?? button('Accept')).toBeDefined();
    expect(button('Refuser') ?? button('Decline')).toBeDefined();
  });

  it('draws nothing for the asks of another conversation', () => {
    setJoinRequestHandlers({ approve: vi.fn(), decline: vi.fn() });
    raiseJoinRequest(ask('carol', 'other-group'));
    render('g1');

    expect(target.querySelector('[data-join-request]')).toBeNull();
  });

  it('draws nothing while nothing can answer, so a tap never lands on nothing', () => {
    raiseJoinRequest(ask('carol'));
    render();

    expect(target.querySelector('[data-join-request]')).toBeNull();
  });

  it('runs the approval on Add and leaves with the ask once it went through', async () => {
    const approve = vi.fn(async () => ({ done: true as const }));
    setJoinRequestHandlers({ approve, decline: vi.fn() });
    raiseJoinRequest(ask('carol'));
    render();

    (button('Accepter') ?? button('Accept'))!.click();
    await tick();
    await tick();

    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'carol', groupId: 'g1' })
    );
    expect(target.querySelector('[data-join-request]')).toBeNull();
  });

  it('runs the decline on Decline', async () => {
    const decline = vi.fn(async () => ({ done: true as const }));
    setJoinRequestHandlers({ approve: vi.fn(), decline });
    raiseJoinRequest(ask('carol'));
    render();

    (button('Refuser') ?? button('Decline'))!.click();
    await tick();
    await tick();

    expect(decline).toHaveBeenCalledTimes(1);
    expect(target.querySelector('[data-join-request]')).toBeNull();
  });

  it('keeps the ask and says so when the answer did not go through', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const approve = vi.fn(async () => ({ done: false as const, reason: 'lock busy' }));
    setJoinRequestHandlers({ approve, decline: vi.fn() });
    raiseJoinRequest(ask('carol'));
    render();

    (button('Accepter') ?? button('Accept'))!.click();
    await tick();
    await tick();

    expect(target.querySelector('[data-join-request="carol"]')).not.toBeNull();
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('shows the real name of an asker no cache held, once it resolves, and links their profile', async () => {
    let resolveIt: (name: string) => void = () => {};
    resolveName.mockImplementationOnce(
      () => new Promise<string | null>((r) => (resolveIt = (n) => r(n)))
    );
    setJoinRequestHandlers({ approve: vi.fn(), decline: vi.fn() });
    raiseJoinRequest(ask('carol'));
    render();
    expect(target.textContent).toContain('Name(carol)');

    resolveIt('Carol Dupont');
    await tick();
    await tick();

    expect(resolveName).toHaveBeenCalledWith('carol');
    expect(target.textContent).toContain('Carol Dupont veut rejoindre la conversation');
    expect(target.textContent).not.toContain('Name(carol)');
    expect(target.querySelector('a[data-join-profile="carol"]')!.getAttribute('href')).toBe(
      '/profile/carol'
    );
  });

  it('says someone is adding people, not that something broke, when the add lock is busy', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const approve = vi.fn(async () => ({
      done: false as const,
      reason: 'the Add did not happen (add-lock-busy)',
      kind: 'busy' as const,
    }));
    setJoinRequestHandlers({ approve, decline: vi.fn() });
    raiseJoinRequest(ask('carol'));
    render();

    (button('Accepter') ?? button('Accept'))!.click();
    await tick();
    await tick();

    expect(showToast).toHaveBeenCalledTimes(1);
    const [text, type] = vi.mocked(showToast).mock.calls[0]!;
    expect(type).toBe('info');
    expect(text).toMatch(/Quelqu'un est en train d'ajouter|Someone is adding people/);
  });

  it('says another member already answered when the answer lost a race', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const approve = vi.fn(async () => ({
      done: false as const,
      reason: 'the Add did not happen (removed-meanwhile)',
      kind: 'raced' as const,
    }));
    setJoinRequestHandlers({ approve, decline: vi.fn() });
    raiseJoinRequest(ask('carol'));
    render();

    (button('Accepter') ?? button('Accept'))!.click();
    await tick();
    await tick();

    const [text, type] = vi.mocked(showToast).mock.calls[0]!;
    expect(type).toBe('info');
    expect(text).toMatch(/déjà répondu|already answered/);
  });

  it('folds two devices of one person into one card', () => {
    setJoinRequestHandlers({ approve: vi.fn(), decline: vi.fn() });
    raiseJoinRequest(ask('carol', 'g1', 'd1'));
    raiseJoinRequest(ask('carol', 'g1', 'd2'));
    render();

    expect(target.querySelectorAll('[data-join-request]')).toHaveLength(1);
  });

  it('words a person ask as a discreet line, never a banner', () => {
    setJoinRequestHandlers({ approve: vi.fn(), decline: vi.fn() });
    raiseJoinRequest(ask('carol'));
    render();

    expect(target.textContent).toContain('Name(carol) veut rejoindre la conversation');
    // No disclosure, no key: a person is asked about, never a device (owner, 2026-10-31).
    expect(target.querySelector('details')).toBeNull();
    expect(target.querySelector('[role="alert"]')).toBeNull();
  });

  it('leaves a line for the member who declined, and none after an Accept', async () => {
    const decline = vi.fn(async () => ({ done: true as const }));
    const approve = vi.fn(async () => ({ done: true as const }));
    setJoinRequestHandlers({ approve, decline });
    raiseJoinRequest(ask('carol'));
    raiseJoinRequest(ask('erin'));
    render();

    (
      target.querySelector(
        '[data-join-request="carol"] [data-join-answer="decline"]'
      ) as HTMLElement
    ).click();
    (
      target.querySelector('[data-join-request="erin"] [data-join-answer="approve"]') as HTMLElement
    ).click();
    await tick();
    await tick();

    expect(target.querySelector('[data-join-request]')).toBeNull();
    expect(target.querySelector('[data-join-declined="carol"]')!.textContent).toContain(
      'Vous avez refusé la demande de Name(carol)'
    );
    // An accepted ask is followed by the ordinary memberAdded notice, written by the Add itself.
    expect(target.querySelector('[data-join-declined="erin"]')).toBeNull();
  });
});
