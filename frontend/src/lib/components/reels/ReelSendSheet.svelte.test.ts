// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

/**
 * "Envoyer a..." (RC-12): the feed row first, DMs and groups after it in the list's order, never a
 * salon; ticks counted against the server's cap with a sentence; chats withheld from a silenced or a
 * too-long take; a muted member cannot tick the feed. The sheet decides nothing - it reports the ticks.
 */
afterAll(adoptTransitionAnimations());

const mute = vi.hoisted(() => ({ muted: false, hang: false }));
vi.mock('$lib/moderation/muteCheck', () => ({
  cachedMuteStatus: () => null,
  getMuteStatus: async () => {
    if (mute.hang) return new Promise(() => {});
    return { isMuted: mute.muted, mutedReason: null };
  },
}));
const blocked = vi.hoisted(() => ({ ids: [] as string[], mode: 'ok' as 'ok' | 'fail' | 'hang' }));
vi.mock('$lib/users/blocks', () => ({
  listBlockedUsers: async () => {
    if (blocked.mode === 'fail') throw new Error('offline');
    if (blocked.mode === 'hang') return new Promise(() => {});
    return blocked.ids.map((userId) => ({ userId }));
  },
}));
const knownNames = vi.hoisted(() => ({
  byId: {} as Record<string, string>,
  asked: [] as string[],
}));
vi.mock('$lib/utils/users/displayName', () => ({
  resolveUserDisplayName: async (id: string) => {
    knownNames.asked.push(id);
    return knownNames.byId[id] ?? null;
  },
  getUserDisplayNameSync: (_id: string, fallback?: string) => fallback ?? 'Utilisateur inconnu',
  peekUserDisplayName: () => null,
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
const { m } = await import('$lib/paraglide/messages');

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

const baseRows = () => [
  convo('g-old', 'Old', 1),
  convo('g-new', 'New', 9),
  convo('channel_s', 'Salon', 20, { conversationType: 'channel' }),
  convo('d-1', 'Dana', 5, { conversationType: 'direct', directPeerId: 'peer-dana' }),
];
const rows = new SvelteMap(baseRows());
const host = { conversations: () => rows.entries(), userId: () => ME };
const video = () => new Blob(['v'], { type: 'video/mp4' });

const mounted: Record<string, unknown>[] = [];
let onsend = vi.fn();
let onclose = vi.fn();

beforeEach(() => {
  mute.muted = false;
  mute.hang = false;
  blocked.ids = [];
  blocked.mode = 'ok';
  rows.clear();
  for (const [k, v] of baseRows()) rows.set(k, v);
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
  props: Partial<{
    clip: object;
    cap: number;
    chatCapMs: number;
    sending: boolean;
    preticked: string | null;
    host: object;
  }> = {}
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
  it('puts "Publier" first, then the conversations by recency and no salon', async () => {
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

  it('says the conversations receive the published video itself only when the feed AND a chat are ticked (15.5)', async () => {
    await open();
    const note = () => document.querySelector('[data-reel-send-same-as-post]');
    feed().click();
    await settle();
    expect(note()).toBeNull();
    row('g-old').click();
    await settle();
    expect(note()?.textContent).toContain(m.reel_sendto_same_as_post());
    feed().click();
    await settle();
    expect(note()).toBeNull();
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

  it('a ticked target the search hides keeps its NAME on its chip, never its raw id (iPhone 12, 2026-11-16)', async () => {
    // A DM whose stored name is the peer's raw id: its label comes from the fetched display name.
    const peer = '43319a65-1d2e-4f00-8a00-000000000001';
    rows.set(
      'd-hex',
      convo('d-hex', peer, 7, { conversationType: 'direct', directPeerId: peer })[1]
    );
    knownNames.byId = { [peer]: 'Canari Test Delta' };
    await open();
    row('d-hex').click();
    await settle();
    const chip = () => document.querySelector('[data-reel-send-chips] button')!;
    expect(chip().textContent).toContain('Canari Test Delta');
    const input = document.querySelector<HTMLInputElement>('[data-reel-send-search]')!;
    input.value = 'old';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(rowKeys()).toEqual(['g-old']);
    expect(chip().textContent).toContain('Canari Test Delta');
    expect(chip().textContent).not.toContain('43319a65');
    expect(chip().getAttribute('aria-label')).toContain('Canari Test Delta');
    knownNames.byId = {};
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

  it('the chat rows stay disabled until the blocked list has answered: a blocked DM is never tickable', async () => {
    blocked.mode = 'hang';
    await open();
    expect(row('d-1').disabled).toBe(true);
    row('d-1').click();
    await settle();
    expect(submit().disabled).toBe(true);
  });

  it('a blocked list that could not be read keeps the chat rows disabled, says so, and still lets the member post', async () => {
    blocked.mode = 'fail';
    await open();
    expect(row('g-old').disabled).toBe(true);
    expect(document.querySelector('[data-reel-send-blocks-unread]')).not.toBeNull();
    feed().click();
    await settle();
    submit().click();
    expect(onsend).toHaveBeenCalledWith({ feed: true, targetKeys: [] });
  });

  it('a feed tick made before the mute answer does not exist: the row waits for it', async () => {
    mute.hang = true;
    await open();
    expect(feed().disabled).toBe(true);
    feed().click();
    await settle();
    expect(feed().getAttribute('aria-checked')).toBe('false');
    expect(submit().disabled).toBe(true);
  });

  it('the send set is what is ticked AND still listed: a row that left the list is not sent', async () => {
    await open();
    row('g-old').click();
    row('d-1').click();
    await settle();
    // The member is removed from a conversation while the sheet is open.
    rows.delete('d-1');
    await settle();
    submit().click();
    expect(onsend).toHaveBeenCalledWith({ feed: false, targetKeys: ['g-old'] });
  });

  it('"Envoyer" is disabled while a press is being written', async () => {
    await open({ sending: true });
    row('g-old').click();
    await settle();
    expect(submit().disabled).toBe(true);
  });
});

describe("ReelSendSheet - Snapchat's list (owner, 2026-11-16, section 22)", () => {
  const titles = () =>
    [...document.querySelectorAll('[data-picker-section]')].map((h) => h.textContent?.trim());

  function manyRows() {
    rows.clear();
    // Ten groups, newest first by `at`: Recents holds six, the rest reads alphabetically.
    const names = [
      'Kilo',
      'Juliet',
      'India',
      'Hotel',
      'Golf',
      'Foxtrot',
      'Echo',
      'Delta',
      'Alpha',
      'Bravo',
    ];
    names.forEach((name, i) => rows.set(`g-${name}`, convo(`g-${name}`, name, 100 - i)[1]));
  }

  it('the search is at the top, then "CanaReels" with the one row "Publier", then "Recents", then the rest', async () => {
    manyRows();
    await open();
    const search = document.querySelector('[data-reel-send-search]')!;
    expect(search.compareDocumentPosition(feed()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(feed().textContent).toContain(m.reel_sendto_feed_row());
    expect(m.reel_sendto_feed_row()).toBe('Publier');
    expect(titles()).toEqual([
      m.reel_sendto_section_feed(),
      m.reel_sendto_section_recent(),
      m.reel_sendto_section_all(),
    ]);
    expect(rowKeys()).toEqual([
      // Recents: the six latest, by last activity.
      'g-Kilo',
      'g-Juliet',
      'g-India',
      'g-Hotel',
      'g-Golf',
      'g-Foxtrot',
      // The rest: alphabetical.
      'g-Alpha',
      'g-Bravo',
      'g-Delta',
      'g-Echo',
    ]);
  });

  it('a typed search is one untitled list of the matches, alphabetical, "Publier" still first', async () => {
    manyRows();
    await open();
    const input = document.querySelector<HTMLInputElement>('[data-reel-send-search]')!;
    input.value = 'o';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(titles()).toEqual([m.reel_sendto_section_feed()]);
    expect(rowKeys()).toEqual(['g-Bravo', 'g-Echo', 'g-Foxtrot', 'g-Golf', 'g-Hotel', 'g-Kilo']);
  });

  it("opened from a conversation's camera, that conversation is ticked from the start", async () => {
    await open({ preticked: 'g-old' });
    expect(row('g-old').getAttribute('aria-checked')).toBe('true');
    expect(row('g-new').getAttribute('aria-checked')).toBe('false');
    expect(submit().disabled).toBe(false);
    submit().click();
    expect(onsend).toHaveBeenCalledWith({ feed: false, targetKeys: ['g-old'] });
  });

  it('a pre-tick this device does not hold ticks nothing', async () => {
    await open({ preticked: 'g-gone' });
    expect(document.querySelectorAll('[aria-checked="true"]')).toHaveLength(0);
    expect(submit().disabled).toBe(true);
  });

  it('opened from the tab, nothing is ticked', async () => {
    await open();
    expect(document.querySelectorAll('[aria-checked="true"]')).toHaveLength(0);
  });

  it("a group's row names a few of its members (never this account), read from the local trees in ONE batch; a DM has none", async () => {
    knownNames.byId = { 'u-a': 'Ana', 'u-b': 'Ben', 'u-c': 'Cleo', 'u-d': 'Dan' };
    const groupMembers = vi.fn(
      async (ids: readonly string[]) =>
        new Map(ids.map((id) => [id, id === 'g-new' ? [ME, 'u-a', 'u-b', 'u-c', 'u-d'] : []]))
    );
    await open({ host: { ...host, groupMembers } });
    await settle();
    expect(row('g-new').querySelector('[data-picker-subtitle]')!.textContent).toBe(
      'Ana, Ben, Cleo'
    );
    expect(row('d-1').querySelector('[data-picker-subtitle]')).toBeNull();
    expect(groupMembers).toHaveBeenCalledTimes(1);
    expect([...groupMembers.mock.calls[0][0]].sort()).toEqual(['g-new', 'g-old']);
    knownNames.byId = {};
  });

  it('a member shared by several groups is looked up ONCE, not once per group', async () => {
    knownNames.byId = { 'u-a': 'Ana', 'u-b': 'Ben' };
    knownNames.asked = [];
    const groupMembers = vi.fn(
      async (ids: readonly string[]) => new Map(ids.map((id) => [id, ['u-a', 'u-b']]))
    );
    await open({ host: { ...host, groupMembers } });
    await settle();
    expect(row('g-new').querySelector('[data-picker-subtitle]')!.textContent).toBe('Ana, Ben');
    expect(row('g-old').querySelector('[data-picker-subtitle]')!.textContent).toBe('Ana, Ben');
    expect(knownNames.asked.filter((id) => id === 'u-a')).toHaveLength(1);
    expect(knownNames.asked.filter((id) => id === 'u-b')).toHaveLength(1);
    knownNames.byId = {};
  });

  it('a group the host could not read keeps its row with no subtitle, and the sheet logs nothing per group', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const groupMembers = vi.fn(async () => new Map<string, string[]>());
    await open({ host: { ...host, groupMembers } });
    await settle();
    expect(row('g-new')).not.toBeNull();
    expect(row('g-new').querySelector('[data-picker-subtitle]')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
