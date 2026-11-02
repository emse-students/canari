// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { Conversation } from '$lib/types';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

/**
 * "Envoyer a..." (RC-12): the feed row first, DMs and groups after it in the list's order, never a
 * salon; ticks counted against the server's cap with a sentence; chats withheld from a silenced or a
 * too-long take; a muted member cannot tick the feed. The sheet decides nothing - it reports the ticks.
 */
afterAll(adoptTransitionAnimations());

const mute = vi.hoisted(() => ({ muted: false }));
vi.mock('$lib/moderation/muteCheck', () => ({
  cachedMuteStatus: () => null,
  getMuteStatus: async () => ({ isMuted: mute.muted, mutedReason: null }),
}));
const blocked = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('$lib/users/blocks', () => ({
  listBlockedUsers: async () => blocked.ids.map((userId) => ({ userId })),
}));
vi.mock('$lib/utils/users/displayName', () => ({
  resolveUserDisplayName: async () => null,
  getUserDisplayNameSync: (_id: string, fallback: string) => fallback,
}));
vi.mock('$lib/components/shared/Avatar.svelte', async () => ({
  default: (await import('./AvatarStub.test-helper.svelte')).default,
}));
vi.mock('$lib/utils/historyOverlayStack', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/historyOverlayStack')>()),
  pushHistoryOverlay: vi.fn(),
  releaseHistoryOverlay: vi.fn(),
  closeHistoryOverlayFromUi: vi.fn((close: () => void) => close()),
}));

const { default: ReelSendSheet } = await import('./ReelSendSheet.svelte');

const ME = '11111111-1111-4111-8111-111111111111';

function convo(
  id: string,
  name: string,
  at: number,
  over: Partial<Conversation> = {}
): [string, Conversation] {
  return [
    id,
    {
      id,
      name,
      contactName: name,
      messages: [],
      lifecycle: 'active',
      mlsStateHex: null,
      conversationType: 'group',
      lastMessageAt: at,
      ...over,
    } as unknown as Conversation,
  ];
}

const rows = [
  convo('g-old', 'Old', 1),
  convo('g-new', 'New', 9),
  convo('channel_s', 'Salon', 20, { conversationType: 'channel' }),
  convo('d-1', 'Dana', 5, { conversationType: 'direct', directPeerId: 'peer-dana' }),
];
const host = { conversations: () => rows, userId: () => ME };
const video = () => new Blob(['v'], { type: 'video/mp4' });

const mounted: Record<string, unknown>[] = [];
let onsend = vi.fn();
let onclose = vi.fn();

beforeEach(() => {
  mute.muted = false;
  blocked.ids = [];
  onsend = vi.fn();
  onclose = vi.fn();
});
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

async function settle() {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

async function open(
  props: Partial<{ clip: object; cap: number; chatCapMs: number }> = {}
): Promise<void> {
  mounted.push(
    mount(ReelSendSheet, {
      target: document.body,
      props: {
        clip: { blob: video(), source: 'camera' },
        host,
        cap: 2,
        chatCapMs: 60_000,
        onclose,
        onsend,
        ...props,
      } as never,
    })
  );
  await settle();
}

const rowKeys = () =>
  [...document.querySelectorAll('[data-reel-send-row]')].map((r) =>
    r.getAttribute('data-reel-send-row')
  );
const row = (key: string) =>
  document.querySelector<HTMLButtonElement>(`[data-reel-send-row="${key}"]`)!;
const feed = () => document.querySelector<HTMLButtonElement>('[data-reel-send-feed]')!;
const submit = () => document.querySelector<HTMLButtonElement>('[data-reel-send-submit]')!;

describe('ReelSendSheet', () => {
  it('puts "Publier sur CanaReels" first, then the conversations by recency and no salon', async () => {
    await open();
    const focusables = [...document.querySelectorAll('[role="checkbox"]')];
    expect(focusables[0]).toBe(feed());
    expect(rowKeys()).toEqual(['g-new', 'd-1', 'g-old']);
  });

  it('names each row with its kind, so a screen reader hears what it ticks', async () => {
    await open();
    expect(row('g-new').getAttribute('aria-label')).toContain('conversation de groupe');
    expect(row('d-1').getAttribute('aria-label')).toBe('Dana, conversation');
    expect(row('g-new').getAttribute('aria-checked')).toBe('false');
  });

  it('is disabled with nothing ticked, and reports the ticks in order', async () => {
    await open();
    expect(submit().disabled).toBe(true);
    feed().click();
    row('g-old').click();
    row('d-1').click();
    await settle();
    expect(submit().disabled).toBe(false);
    expect(submit().textContent).toContain('3');
    submit().click();
    expect(onsend).toHaveBeenCalledWith({ feed: true, targetKeys: ['g-old', 'd-1'] });
  });

  it('REFUSES a tick past the cap with a sentence, and an untick frees a place', async () => {
    await open({ cap: 2 });
    row('g-old').click();
    row('d-1').click();
    row('g-new').click();
    await settle();
    expect(row('g-new').getAttribute('aria-checked')).toBe('false');
    expect(document.querySelector('[data-reel-send-cap]')?.textContent).toContain('2');
    row('d-1').click();
    await settle();
    expect(document.querySelector('[data-reel-send-cap]')).toBeNull();
    row('g-new').click();
    await settle();
    expect(row('g-new').getAttribute('aria-checked')).toBe('true');
  });

  it('the feed row never counts against the conversation cap', async () => {
    await open({ cap: 1 });
    feed().click();
    row('g-old').click();
    await settle();
    expect(row('g-old').getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[data-reel-send-cap]')).toBeNull();
  });

  it('filters the rows locally on the search', async () => {
    await open();
    const input = document.querySelector<HTMLInputElement>('[data-reel-send-search]')!;
    input.value = 'dan';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(rowKeys()).toEqual(['d-1']);
  });

  it('leaves out the DM of a person the member blocked', async () => {
    blocked.ids = ['peer-dana'];
    await open();
    expect(rowKeys()).toEqual(['g-new', 'g-old']);
  });

  it('a muted member cannot tick the feed row, and is told why', async () => {
    mute.muted = true;
    await open();
    expect(feed().disabled).toBe(true);
    expect(document.querySelector('[data-reel-send-muted]')).not.toBeNull();
    row('g-old').click();
    await settle();
    submit().click();
    expect(onsend).toHaveBeenCalledWith({ feed: false, targetKeys: ['g-old'] });
  });

  it('a take whose sound was removed can only be posted: the chat rows are disabled, with the reason', async () => {
    await open({ clip: { blob: video(), source: 'camera', soundRemoved: true } });
    expect(row('g-old').disabled).toBe(true);
    expect(document.querySelector('[data-reel-send-silent]')).not.toBeNull();
    feed().click();
    await settle();
    expect(feed().getAttribute('aria-checked')).toBe('true');
  });

  it('a take over the chat cap can only be posted, said with the cap in seconds', async () => {
    await open({ clip: { blob: video(), source: 'camera', durationMs: 75_000 } });
    expect(row('g-old').disabled).toBe(true);
    expect(document.querySelector('[data-reel-send-too-long]')?.textContent).toContain('60');
  });

  it('a take whose length is unknown keeps the chats open: the outbox still refuses a long one', async () => {
    await open();
    expect(row('g-old').disabled).toBe(false);
  });

  it('Back asks the owner to return to the take', async () => {
    await open();
    document.querySelector<HTMLButtonElement>('header button')!.click();
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});
