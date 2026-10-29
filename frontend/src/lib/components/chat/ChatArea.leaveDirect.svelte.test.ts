// @vitest-environment happy-dom
/**
 * LEAVING A DM MUST NOT FREEZE THE PANE OF THE CONVERSATION OPENED NEXT (TOK-3 / OFF-2, 2026-10-27).
 *
 * `ChatHeader` watches a DM peer's presence in an effect whose TEARDOWN named the peer by reading the
 * `contactName` prop. Svelte runs a teardown against the values the effect last saw, so that read
 * walked `ChatArea`'s props back to `currentConvo` and re-evaluated it with the PREVIOUS selection -
 * and a derived re-evaluated there keeps the dependencies of that evaluation. `currentConvo` read the
 * map by the DM's key, so it stopped listening to the key of the conversation now open: every
 * message added to it reached the map and the sidebar, never the pane, until the selection changed
 * again. Measured on the rig with logpoints: `currentConvo` evaluated with the DM's key while the
 * selection source already held the group's.
 *
 * Wired here the way `MainChatPage` wires it - `conversation` is `currentConvo`, read through a getter
 * - with the real `useConversations`, the real `ChatArea` and its real `ChatHeader`.
 */
import { flushSync, mount, unmount } from 'svelte';

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
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));

const { default: ChatArea } = await import('./ChatArea.svelte');
const { useConversations } = await import('$lib/composables/useConversations.svelte');

const ROW = '[id^="msg-"]';
const DM = 'alice';
const GROUP = 'a8f3c1d2-0000-4000-8000-000000000001';

const message = (id: string, second: number) => ({
  id,
  senderId: 'alice',
  content: `text ${id}`,
  timestamp: new Date(Date.UTC(2026, 9, 27, 16, 0, second)),
  isOwn: false,
});

function row(id: string, type: 'direct' | 'group', messages: unknown[]) {
  return {
    id,
    name: id,
    contactName: id,
    conversationType: type,
    ...(type === 'direct' ? { directPeerId: id } : {}),
    lifecycle: 'active',
    messages,
  } as never;
}

describe('ChatArea after leaving a DM', () => {
  it('renders the messages added to the conversation opened next', () => {
    const convs = useConversations();
    convs.conversations.set(DM, row(DM, 'direct', [message('d1', 1)]));
    convs.conversations.set(GROUP, row(GROUP, 'group', []));
    convs.selectConversation(DM);

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
      } as never,
    });
    try {
      flushSync();
      expect(target.querySelectorAll(ROW)).toHaveLength(1);

      convs.selectConversation(GROUP);
      flushSync();
      expect(target.querySelectorAll(ROW)).toHaveLength(0);

      // What `batchAddMessages` does: a new object under the open key.
      const open = convs.conversations.get(GROUP) as unknown as object;
      convs.conversations.set(GROUP, { ...open, messages: [message('g1', 2)] } as never);
      flushSync();

      expect(target.querySelector('#msg-g1')).not.toBeNull();
    } finally {
      void unmount(app);
      target.remove();
    }
  });
});
