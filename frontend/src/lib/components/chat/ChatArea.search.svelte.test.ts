// @vitest-environment happy-dom
/**
 * THE IN-CONVERSATION SEARCH BAR (owner, 2026-11-11): typing a term takes the reader to the match the
 * counter calls 1 without pressing "next"; Enter / Shift+Enter step; the tap on the magnifier focuses
 * the field in the same call stack; Escape closes the bar and returns the focus to the magnifier.
 */
import { flushSync, mount, unmount } from 'svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

const undoAnimations = adoptTransitionAnimations();
afterAll(() => undoAnimations());

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));
/** The presence poll is HTTP; what is under test is only the effect around it. */
vi.mock('$lib/stores/presenceStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/presenceStore')>()),
  watchUsers: () => {},
  unwatchUsers: () => {},
}));
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  resolveUserDisplayName: async (id: string) => id,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplay: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplay: () => {},
}));

const { default: ChatArea } = await import('./ChatArea.svelte');
const { useConversations } = await import('$lib/composables/useConversations.svelte');
const { m } = await import('$lib/paraglide/messages');

const message = (id: string, second: number, content: string) => ({
  id,
  senderId: 'alice',
  content,
  timestamp: new Date(Date.UTC(2026, 10, 11, 9, 0, second)),
  isOwn: false,
});

const HIGHLIGHT = 'chat-message-jump-highlight';

function setup(matches: string[]) {
  const convs = useConversations();
  convs.conversations.set('alice', {
    id: 'alice',
    name: 'alice',
    contactName: 'alice',
    conversationType: 'direct',
    directPeerId: 'alice',
    lifecycle: 'active',
    messages: [message('m1', 1, 'hello'), message('m2', 2, 'hello again'), message('m3', 3, 'x')],
  } as never);
  convs.selectConversation('alice');
  const onSearchAll = vi.fn(async () => matches);
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ChatArea, {
    target,
    props: {
      get conversation() {
        return convs.currentConvo;
      },
      currentUserId: 'me',
      messageText: '',
      onMessageChange: () => {},
      onSend: () => {},
      onInviteMembers: () => {},
      onSearchAll,
    } as never,
  });
  flushSync();
  const magnifier = target.querySelector(
    `button[aria-label="${m.chat_search_in_conversation_label()}"]`
  ) as HTMLButtonElement;
  const field = () => target.querySelector('.chat-search-input') as HTMLInputElement | null;
  const type = async (value: string) => {
    const el = field()!;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    await vi.waitFor(() => expect(onSearchAll).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  };
  const press = (key: string, shiftKey = false) => {
    field()!.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
    flushSync();
  };
  const highlighted = () =>
    [...target.querySelectorAll(`.${HIGHLIGHT}`)].map((e) => e.id).join(',');
  const dispose = () => {
    void unmount(app);
    target.remove();
  };
  return { magnifier, field, type, press, highlighted, dispose, target };
}

describe('in-conversation search', () => {
  it('focuses the field inside the tap, and Escape returns the focus to the magnifier', () => {
    const s = setup([]);
    try {
      expect(s.field()).toBeNull();
      s.magnifier.click();
      expect(s.field()).not.toBeNull();
      expect(document.activeElement).toBe(s.field());
      s.press('Escape');
      expect(document.activeElement).toBe(s.magnifier);
    } finally {
      s.dispose();
    }
  });

  it('lands on the NEWEST match, Enter goes toward newer and Shift+Enter toward older', async () => {
    // `onSearchAll` answers oldest-first; the bar shows the newest as 1.
    const s = setup(['m1', 'm2', 'm3']);
    try {
      s.magnifier.click();
      await s.type('hello');
      const count = () => s.target.querySelector('.chat-search-count')?.textContent?.trim();
      expect(count()).toBe('1/3');
      expect(s.highlighted()).toBe('msg-m3');

      // Shift+Enter (the up arrow) climbs to older matches.
      s.press('Enter', true);
      await vi.waitFor(() => expect(s.highlighted()).toContain('msg-m2'));
      expect(count()).toBe('2/3');

      // Enter (the down arrow) comes back toward newer ones.
      s.press('Enter');
      await vi.waitFor(() => expect(count()).toBe('1/3'));
    } finally {
      s.dispose();
    }
  });
});
