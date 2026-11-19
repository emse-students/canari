// @vitest-environment happy-dom
/**
 * The forward / share picker, drawn by the shared `ConversationPickList` since the "Envoyer a..."
 * sheet was built on it (owner, 2026-11-16): its behaviour must not move - one untitled list, most
 * recent first and alphabetical once searched, a salon named with its community, the share-sheet
 * suggestion first and highlighted, a tap picking at once with the name as listed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { Conversation } from '$lib/types';

vi.mock('$lib/utils/users/displayName', () => ({
  resolveUserDisplayName: async () => null,
  getUserDisplayNameSync: (_id: string, fallback: string) => fallback,
}));
vi.mock('$lib/components/shared/Avatar.svelte', async () => ({
  default: (await import('../reels/AvatarStub.test-helper.svelte')).default,
}));

const { default: ForwardMessageModal } = await import('./ForwardMessageModal.svelte');
const { m } = await import('$lib/paraglide/messages');

const ME = '11111111-1111-4111-8111-111111111111';

function convo(
  key: string,
  id: string,
  name: string,
  at: number,
  over: Partial<Conversation> = {}
): [string, Conversation] {
  return [
    key,
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

const SALON = 'channel_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const conversations = (): [string, Conversation][] => [
  convo('g-old', 'g-old', 'Zeta', 1),
  convo('g-new', 'g-new', 'Beta', 9),
  convo('src', 'src', 'Source', 50),
  convo(SALON, SALON, 'General', 5, { conversationType: 'channel' }),
];

const mounted: Record<string, unknown>[] = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

async function open(props: Record<string, unknown> = {}) {
  const onSelect = vi.fn();
  mounted.push(
    mount(ForwardMessageModal, {
      target: document.body,
      props: {
        open: true,
        conversations: conversations(),
        excludeKey: 'src',
        currentUserId: ME,
        channelWorkspaces: [{ name: 'Les Bricoleurs', channels: [{ id: SALON }] }],
        onClose: vi.fn(),
        onSelect,
        ...props,
      },
    })
  );
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
  return onSelect;
}

const rowNames = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')]
    .map((b) => b.querySelector('.font-semibold')?.textContent?.trim())
    .filter((t): t is string => !!t);

describe('ForwardMessageModal on the shared list', () => {
  it('lists every thread but the source, most recent first, in ONE untitled list', async () => {
    await open();
    expect(rowNames()).toEqual(['Beta', 'General', 'Zeta']);
    expect(document.querySelector('[data-picker-section]')).toBeNull();
  });

  it('names a salon with its community under it', async () => {
    await open();
    expect(document.body.textContent).toContain('Les Bricoleurs');
  });

  it('a tap picks at once, with the key, the conversation and the name as listed', async () => {
    const onSelect = await open();
    const beta = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Beta')
    )!;
    beta.click();
    expect(onSelect).toHaveBeenCalledWith(
      'g-new',
      expect.objectContaining({ id: 'g-new' }),
      'Beta'
    );
  });

  it('a typed search reads alphabetically', async () => {
    await open();
    const input = document.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(input.getAttribute('aria-label')).toBe(m.chat_search_discussion_label());
    input.value = 'e';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    flushSync();
    expect(rowNames()).toEqual(['Beta', 'Zeta', 'General']);
  });

  it('says so when nothing matches', async () => {
    await open();
    const input = document.querySelector<HTMLInputElement>('input[type="text"]')!;
    input.value = 'nothing-like-this';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    flushSync();
    expect(document.body.textContent).toContain(m.chat_no_discussion_found());
  });

  it('offers the share-sheet suggestion first, highlighted and marked current', async () => {
    await open({ variant: 'share', preselectedId: 'g-old' });
    expect(rowNames()[0]).toBe('Zeta');
    const zeta = document.querySelector<HTMLButtonElement>('button[aria-current="true"]')!;
    expect(zeta.textContent).toContain('Zeta');
    expect(zeta.className).toContain('ring-2');
    expect(document.querySelectorAll('button[aria-current="true"]')).toHaveLength(1);
  });

  it('draws the forward arrow for a forward and the send arrow for a share', async () => {
    await open();
    expect(document.querySelector('svg.lucide-forward')).not.toBeNull();
    unmount(mounted.pop()!);
    document.body.innerHTML = '';
    await open({ variant: 'share' });
    expect(document.querySelector('svg.lucide-send')).not.toBeNull();
    expect(document.querySelector('svg.lucide-forward')).toBeNull();
  });
});
