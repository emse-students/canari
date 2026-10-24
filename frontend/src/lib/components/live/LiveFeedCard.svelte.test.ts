// @vitest-environment happy-dom
/**
 * The feed's LIVE card as a reader meets it: nothing at all with no live on air, one row per live
 * naming who broadcasts (a member, or an association by its name), a tap opening the viewer, and a
 * new list at each feed refresh - a lost answer keeps the rows, a refusal removes the card.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import LiveFeedCard from './LiveFeedCard.svelte';
import type { LiveListItem } from '$lib/live/types';
import type { OpenLivesOutcome } from '$lib/live/openLives';
import { m } from '$lib/paraglide/messages';

vi.mock('$lib/components/shared/Avatar.svelte', async () => ({
  default: (await import('../reels/AvatarStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/shared/AssociationAvatar.svelte', async () => ({
  default: (await import('../reels/AvatarStub.test-helper.svelte')).default,
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `sync-${id}`,
  resolveUserDisplayName: async (id: string) => `Name ${id}`,
}));
vi.mock('$lib/associations/api', () => ({
  getAssociation: async (id: string) => ({ id, name: `Asso ${id}`, logoUrl: null }),
}));

const item = (
  id: string,
  broadcasterId: string,
  associationId: string | null = null
): LiveListItem => ({
  id,
  broadcasterId,
  associationId,
  startedAt: '2026-10-19T10:00:00.000Z',
});

const mounted: Record<string, unknown>[] = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

async function settle() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

function render(outcomes: OpenLivesOutcome[]) {
  const load = vi.fn(async () => outcomes.shift() ?? { kind: 'kept' as const });
  const onOpen = vi.fn();
  const props = $state({ refreshKey: 1, viewerId: 'me', onOpen, load });
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(LiveFeedCard, { target, props }));
  return { load, onOpen, props };
}

const rows = () => [...document.querySelectorAll<HTMLButtonElement>('[data-live-open]')];

describe('LiveFeedCard', () => {
  it('draws nothing while nothing is on air', async () => {
    render([{ kind: 'answered', lives: [] }]);
    await settle();
    expect(document.querySelector('[data-live-feed-card]')).toBeNull();
  });

  it('lists each live with who broadcasts, and a tap opens it', async () => {
    const a = item('l1', 'u1');
    const b = item('l2', 'u2', 'asso-9');
    const { onOpen } = render([{ kind: 'answered', lives: [a, b] }]);
    await settle();
    expect(document.querySelector('[data-live-feed-card] h2')?.textContent).toContain(
      m.live_card_title()
    );
    expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual([
      m.live_card_is_live({ name: 'Name u1' }),
      m.live_card_is_live({ name: 'Asso asso-9' }),
    ]);
    expect(document.querySelectorAll('[data-live-badge]')).toHaveLength(2);
    rows()[1].click();
    expect(onOpen).toHaveBeenCalledWith(b);
  });

  it('asks again at each feed refresh: a lost answer keeps the rows, a refusal removes the card', async () => {
    const { load, props } = render([
      { kind: 'answered', lives: [item('l1', 'u1')] },
      { kind: 'kept' },
      { kind: 'hidden' },
    ]);
    await settle();
    expect(rows()).toHaveLength(1);
    props.refreshKey = 2;
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(1);
    props.refreshKey = 3;
    await settle();
    expect(document.querySelector('[data-live-feed-card]')).toBeNull();
  });
});
