// @vitest-environment happy-dom
/**
 * AN EDIT LEFT OPEN WHEN THE COMPOSER UNMOUNTS GIVES ITS DRAFT BACK (review of #2614, 2026-10-27).
 *
 * The drafts live in `useMessaging`, which outlives the chat page: a route change (/chat <->
 * /communities, a profile link, a notification's landing) unmounts the page with the conversation
 * id unchanged, so the id effect never reset the edit - the edited message's text stayed as the
 * draft, with no banner, for Send to post a second time. The unmount resets it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatArea from './ChatArea.svelte';
import type { Conversation } from '$lib/types';

const { reset } = vi.hoisted(() => ({ reset: vi.fn() }));
vi.mock('$lib/utils/chat/editSession.svelte', () => ({
  createEditSession: () => ({
    original: null,
    begin: () => {},
    cancel: () => {},
    confirm: () => {},
    reset: (why?: string) => reset(why),
  }),
}));
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  resolveUserDisplayName: async (id: string) => id,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));

beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }) as unknown as MediaQueryList
  );
  reset.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ChatArea edit session', () => {
  it('is reset when the composer unmounts, the conversation unchanged', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(ChatArea, {
      target,
      props: {
        conversation: {
          id: 'g1',
          name: 'Salon',
          contactName: 'g1',
          messages: [],
          lifecycle: 'active',
          mlsStateHex: null,
        } as unknown as Conversation,
        messageText: '',
        onMessageChange: () => {},
        bindDraftWriter: () => () => {},
        onSend: () => {},
        onInviteMembers: () => {},
        onBack: () => {},
      },
    });
    flushSync();
    // The mount's own id effect resets once, before any edit could be open.
    reset.mockClear();

    void unmount(app);
    target.remove();

    expect(reset).toHaveBeenCalledWith('its composer unmounted');
  });
});
