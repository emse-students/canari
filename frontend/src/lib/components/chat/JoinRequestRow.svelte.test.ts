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
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `Name(${id})`,
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
    expect(button('Ajouter') ?? button('Add')).toBeDefined();
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

    (button('Ajouter') ?? button('Add'))!.click();
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

    (button('Ajouter') ?? button('Add'))!.click();
    await tick();
    await tick();

    expect(target.querySelector('[data-join-request="carol"]')).not.toBeNull();
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('folds two devices of one person into one card', () => {
    setJoinRequestHandlers({ approve: vi.fn(), decline: vi.fn() });
    raiseJoinRequest(ask('carol', 'g1', 'd1'));
    raiseJoinRequest(ask('carol', 'g1', 'd2'));
    render();

    expect(target.querySelectorAll('[data-join-request]')).toHaveLength(1);
  });
});
