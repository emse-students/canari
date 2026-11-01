// @vitest-environment happy-dom
/**
 * A SECOND SEND WHILE A MEDIA SEND HOLDS THE STAGING IS A NO-OP (2026-10-31).
 *
 * A member tapped Send 13 times on one staged video while the first tap was held for 18 s, and 13
 * copies went out. The composer's Send is enabled by "text or a staged file" and nothing else in a DM
 * - `isUploading` is raised by the salon branch only - so the fix is that `handleSendChat` claims the
 * staged files before its first await: the composer then holds no file, the button is disabled, and
 * a tap that still reaches it finds nothing to send. The pre-send barrier that held the send then is
 * gone (the file is queued at the tap, chat.md "A file is queued at the tap"), but a send still
 * awaits its durable write; this drives the REAL composer against the REAL messaging composable with
 * that write held open, and counts what reaches the outbox.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

const enqueueMock = vi.fn();
vi.mock('$lib/utils/chat/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/outbox')>();
  return { ...actual, enqueueOutboxMessage: (...args: unknown[]) => enqueueMock(...args) };
});

import ChatComposer from './ChatComposer.svelte';
import { useMessaging, type MessagingContext } from '$lib/composables/useMessaging.svelte';
import type { Conversation } from '$lib/types';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The claimed file leaves the attachment strip mid-test: its outro is a cancelled Web Animation.
afterAll(adoptTransitionAnimations());

const CONVO = 'conversation-key';
const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

/** The media enqueues held open until the test settles them (the durable write still running). */
const heldEnqueues: Array<() => void> = [];

beforeEach(() => {
  enqueueMock.mockReset();
  heldEnqueues.length = 0;
  enqueueMock.mockImplementation((entry?: { kind: string }) =>
    entry?.kind === 'media'
      ? new Promise<void>((resolve) => heldEnqueues.push(resolve))
      : Promise.resolve()
  );
  // The upload ceiling, asked once when a file is staged: answered generously.
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ maxBytes: 50 * 1024 * 1024 }),
        }) as Response
    )
  );
  // happy-dom has no object URLs, and the attachment strip asks for one per staged file.
  URL.createObjectURL = () => 'blob:probe/1';
  URL.revokeObjectURL = () => {};
});

/** A DM the member can send into. */
function dmContext(): MessagingContext {
  return {
    conversations: new SvelteMap<string, Conversation>([
      [
        CONVO,
        {
          id: CONVO,
          name: CONVO,
          messages: [],
          unreadCount: 0,
          lastMessageAt: 0,
          lifecycle: 'active',
        } as never,
      ],
    ]),
    userId: 'me',
    selectedContact: CONVO,
    // Live, like the page's: a test that moves the selection moves what is on screen.
    selectedNow(this: { selectedContact: string | null }) {
      return this.selectedContact;
    },
    setSendError: vi.fn(),
    log: vi.fn(),
  } as unknown as MessagingContext;
}

describe('the composer while a media send holds the staging', () => {
  it('disables Send, and a second tap queues nothing more', async () => {
    const messaging = useMessaging();
    const ctx = dmContext();
    await messaging.handleFilesSelected(
      [new File(['%PDF'], 'a.pdf', { type: 'application/pdf' })],
      ctx
    );

    const sends: Promise<boolean | undefined>[] = [];
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(ChatComposer, {
      target,
      props: {
        messageText: '',
        onMessageChange: () => {},
        onSend: () => {
          sends.push(messaging.handleSendChat(ctx, ''));
        },
        get pendingFiles() {
          return messaging.pendingMediaFilesFor(CONVO);
        },
        onRemovePendingFile: () => {},
        get isUploading() {
          return messaging.isUploadingMedia;
        },
      },
    });
    mounted.push(() => void unmount(app));
    flushSync();

    const send = document.querySelector<HTMLButtonElement>('.chat-composer-send-button')!;
    expect(send.disabled).toBe(false);

    send.click();
    flushSync();
    expect(sends).toHaveLength(1);
    // The first send is parked before its write ends, and the composer already holds no file.
    expect(messaging.pendingMediaFilesFor(CONVO)).toHaveLength(0);
    expect(send.disabled).toBe(true);

    send.click();
    flushSync();
    expect(sends).toHaveLength(1);
    // A tap that reaches the composable anyway (a stale button) finds nothing staged either.
    sends.push(messaging.handleSendChat(ctx, ''));

    await vi.waitFor(() => expect(heldEnqueues).toHaveLength(1));
    heldEnqueues[0]();
    await Promise.all(sends);

    expect(
      enqueueMock.mock.calls.filter(([e]) => (e as { kind: string }).kind === 'media')
    ).toHaveLength(1);
    expect(ctx.conversations.get(CONVO)!.messages).toHaveLength(1);
  });
});
