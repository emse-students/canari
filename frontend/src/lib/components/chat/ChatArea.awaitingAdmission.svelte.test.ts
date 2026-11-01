// @vitest-environment happy-dom
/**
 * THE JOINER WHO OPENS THEIR NEVER-ADMITTED ROW is told what it waits for: an empty thread with a
 * live composer and no explanation was the defect. A row that was admitted shows no such line.
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
const { m } = await import('$lib/paraglide/messages');

const GROUP = 'a8f3c1d2-0000-4000-8000-000000000001';

function render(extra: Record<string, unknown>) {
  const conversation = {
    id: GROUP,
    name: 'Club',
    contactName: GROUP,
    conversationType: 'group',
    messages: [],
    ...extra,
  } as never;
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ChatArea, {
    target,
    props: {
      conversation,
      currentUserId: 'me',
      messageText: '',
      onMessageChange: () => {},
      onSend: () => {},
      onInviteMembers: () => {},
    } as never,
  });
  flushSync();
  return {
    target,
    done: () => {
      void unmount(app);
      target.remove();
    },
  };
}

describe('ChatArea - the joiner whose ask is unanswered', () => {
  it('says it waits for a member to add them', () => {
    const { target, done } = render({ lifecycle: 'pending', awaitingAdmission: true });
    try {
      const notice = target.querySelector('[data-awaiting-admission-notice]');
      expect(notice).not.toBeNull();
      expect(notice!.textContent).toContain(m.chat_awaiting_admission_notice());
      // The device line is for a member's own further device, never for a person's ask.
      expect(target.querySelector('[data-own-device-key]')).toBeNull();
    } finally {
      done();
    }
  });

  it('shows no such line for an admitted conversation', () => {
    const { target, done } = render({ lifecycle: 'active' });
    try {
      expect(target.querySelector('[data-awaiting-admission-notice]')).toBeNull();
    } finally {
      done();
    }
  });
});
