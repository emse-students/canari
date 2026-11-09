// @vitest-environment happy-dom
/**
 * "MODIFIER LES PSEUDOS" - the screen. What it OFFERS is decided by `mayNameMember`, where a change
 * goes by `place`; this file checks the screen draws those decisions and hands a change on.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplay: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplay: () => {},
}));
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))),
}));
vi.mock('$lib/stores/userState.svelte', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/userState.svelte')>()),
  currentUserId: () => 'me',
}));
const isBlockedWith = vi.fn(async (_id: string) => false);
vi.mock('$lib/users/blocks', () => ({
  USER_BLOCKED_CODE: 'USER_BLOCKED',
  isBlockedWith: (id: string) => isBlockedWith(id),
}));
const listCommunityNicknames = vi.fn(async () => [] as unknown[]);
const setCommunityNickname = vi.fn();
vi.mock('$lib/services/ChannelService', () => ({
  channelService: {
    listCommunityNicknames: (...a: unknown[]) => listCommunityNicknames(...(a as [])),
    setCommunityNickname: (...a: unknown[]) => setCommunityNickname(...a),
  },
}));
const createReport = vi.fn(async () => ({}));
vi.mock('$lib/moderation/api', async (orig) => ({
  ...(await orig<typeof import('$lib/moderation/api')>()),
  createReport: (...a: unknown[]) => createReport(...(a as [])),
}));

import NicknamesPanel from './NicknamesPanel.svelte';
import { m } from '$lib/paraglide/messages';
import {
  applyNickname,
  communityNicknameScope,
  nicknameEntry,
  resetConversationNicknamesForTests,
} from '$lib/utils/users/conversationNicknames.svelte';
import { seedUserDisplayName } from '$lib/utils/users/displayName';

const mounted: (() => void)[] = [];

beforeEach(() => {
  localStorage.clear();
  resetConversationNicknamesForTests();
  seedUserDisplayName('me', 'Moi Meme');
  seedUserDisplayName('bob', 'Bob Martin');
  seedUserDisplayName('ann', 'Ann Durand');
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function render(props: Record<string, unknown>) {
  const c = mount(NicknamesPanel, {
    target: document.body,
    props: {
      open: true,
      members: ['me', 'bob'],
      viewerId: 'me',
      onClose: () => {},
      ...props,
    } as never,
  });
  mounted.push(() => void unmount(c));
  await tick();
  flushSync();
}

const row = (id: string) => document.querySelector(`[data-nickname-row="${id}"]`) as HTMLElement;

async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await tick();
  flushSync();
}

describe('NicknamesPanel in a group', () => {
  it('shows the nickname, the profile name and who set it', async () => {
    applyNickname('g1', 'bob', { nickname: 'Capitaine', setBy: 'ann', at: 1 });
    await render({ place: { kind: 'group', scope: 'g1', send: async () => true } });
    const text = row('bob').textContent ?? '';
    expect(text).toContain('Capitaine');
    expect(text).toContain('Bob Martin');
    expect(text).toContain(m.chat_nicknames_set_by({ name: 'Ann Durand' }));
  });

  it('sends a new nickname through the place, then shows it', async () => {
    const send = vi.fn(async () => true);
    await render({ place: { kind: 'group', scope: 'g1', send } });
    (row('bob').querySelector('[data-nickname-edit]') as HTMLButtonElement).click();
    flushSync();
    const input = row('bob').querySelector('[data-nickname-input]') as HTMLInputElement;
    input.value = 'Capitaine';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(send).toHaveBeenCalledWith('bob', 'Capitaine', expect.any(Number));
    expect(nicknameEntry('g1', 'bob')?.nickname).toBe('Capitaine');
    expect(row('bob').textContent).toContain('Capitaine');
  });

  it('offers no report outside a community - nothing of it reaches a server', async () => {
    applyNickname('g1', 'bob', { nickname: 'Capitaine', setBy: 'ann', at: 1 });
    await render({ place: { kind: 'group', scope: 'g1', send: async () => true } });
    expect(document.querySelector('[data-nickname-report]')).toBeNull();
  });

  it('tells the target a nickname they cannot see is set once the block is KNOWN, and offers its reset', async () => {
    let answer: (blocked: boolean) => void = () => {};
    isBlockedWith.mockImplementation(() => new Promise<boolean>((r) => (answer = r)));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    applyNickname('g1', 'me', { nickname: 'Insult', setBy: 'bob', at: 1 });
    await render({ place: { kind: 'group', scope: 'g1', send: async () => true } });
    await settle();
    // Pending: the plain name, neither the nickname nor a notice that may turn out wrong.
    expect(row('me').textContent).not.toContain('Insult');
    expect(row('me').querySelector('[data-nickname-hidden]')).toBeNull();
    answer(true);
    await settle();
    expect(row('me').textContent).not.toContain('Insult');
    expect(row('me').querySelector('[data-nickname-hidden]')?.textContent).toContain(
      m.chat_nicknames_hidden_for_you()
    );
    expect(row('me').querySelector('[data-nickname-reset]')).not.toBeNull();
    isBlockedWith.mockImplementation(async () => false);
  });

  it('shows the nickname, and never the notice, once the answer is clear', async () => {
    let answer: (blocked: boolean) => void = () => {};
    isBlockedWith.mockImplementation(() => new Promise<boolean>((r) => (answer = r)));
    applyNickname('g1', 'me', { nickname: 'Chef', setBy: 'bob', at: 1 });
    await render({ place: { kind: 'group', scope: 'g1', send: async () => true } });
    await settle();
    expect(row('me').querySelector('[data-nickname-hidden]')).toBeNull();
    answer(false);
    await settle();
    expect(row('me').textContent).toContain('Chef');
    expect(row('me').querySelector('[data-nickname-hidden]')).toBeNull();
    isBlockedWith.mockImplementation(async () => false);
  });
});

describe('NicknamesPanel in a community', () => {
  const scope = communityNicknameScope('w1');

  it('offers a member no pencil, but the reset of their own nickname and the report of it', async () => {
    const held = {
      nickname: 'Chef',
      setBy: 'ann',
      at: 1,
      reportSubject: '00000000-0000-0000-0000-000000000001@1',
    };
    applyNickname(scope, 'me', held);
    // The server's list names it too: a held entry the list does not name is dropped.
    listCommunityNicknames.mockResolvedValueOnce([{ userId: 'me', ...held }]);
    await render({ place: { kind: 'community', workspaceId: 'w1', canModerate: false } });
    await settle();
    expect(document.querySelector('[data-nickname-edit]')).toBeNull();
    expect(row('me').querySelector('[data-nickname-reset]')).not.toBeNull();
    expect(row('bob').querySelector('[data-nickname-reset]')).toBeNull();
    expect(row('me').querySelector('[data-nickname-report]')).not.toBeNull();
    expect(listCommunityNicknames).toHaveBeenCalledWith('w1');
  });

  it('offers a moderator a pencil on every row', async () => {
    await render({ place: { kind: 'community', workspaceId: 'w1', canModerate: true } });
    expect(document.querySelectorAll('[data-nickname-edit]')).toHaveLength(2);
  });

  it("shows a refusal as the screen's sentence", async () => {
    const { ApiRefusalError } = await import('$lib/utils/apiRefusalError');
    setCommunityNickname.mockRejectedValueOnce(new ApiRefusalError(403, 'USER_BLOCKED', 'blocked'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render({ place: { kind: 'community', workspaceId: 'w1', canModerate: true } });
    (row('bob').querySelector('[data-nickname-edit]') as HTMLButtonElement).click();
    flushSync();
    const input = row('bob').querySelector('[data-nickname-input]') as HTMLInputElement;
    input.value = 'X';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      m.chat_nicknames_error_blocked()
    );
  });
});
