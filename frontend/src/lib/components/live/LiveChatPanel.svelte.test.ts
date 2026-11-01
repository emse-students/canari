// @vitest-environment happy-dom
/**
 * THE LIVE CHAT PANEL, MOUNTED: a line is TEXT (a link or markup stays text, C15), my own line says
 * "You", a failed line shows its reason and offers retry only where retrying can help, the hide
 * button exists for a moderator alone, the composer sends and empties, and the floating layer keeps
 * its on-screen cap.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import LiveChatPanel from './LiveChatPanel.svelte';
import LiveReactionsLayer from './LiveReactionsLayer.svelte';
import type { LiveChatLine } from '$lib/live/liveChat';
import { m } from '$lib/paraglide/messages';

vi.mock('$lib/components/shared/Avatar.svelte', () => ({ default: () => {} }));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => (id.startsWith('b') ? 'Bob' : ''),
  resolveUserDisplayName: async () => 'Bob',
}));

const BOB = 'b'.repeat(64);
const ME = 'a'.repeat(64);

function line(over: Partial<LiveChatLine>): LiveChatLine {
  return {
    id: 'm-1',
    clientId: 'c-1',
    authorId: BOB,
    text: 'hello',
    seq: 1,
    status: 'sent',
    mine: false,
    ...over,
  };
}

let app: ReturnType<typeof mount> | null = null;

function render(props: Partial<Parameters<typeof LiveChatPanel>[1]> = {}) {
  const target = document.createElement('div');
  document.body.append(target);
  const handlers = {
    send: vi.fn(async () => null),
    retry: vi.fn(),
    discard: vi.fn(),
    hide: vi.fn(),
  };
  app = mount(LiveChatPanel, {
    target,
    props: { lines: [], canWrite: true, maxChars: 300, ...handlers, ...props },
  });
  flushSync();
  return { target, ...handlers };
}

afterEach(() => {
  if (app) unmount(app);
  app = null;
  document.body.innerHTML = '';
});

describe('LiveChatPanel', () => {
  it('draws a message as plain text: markup and links stay text', () => {
    const { target } = render({
      lines: [line({ text: '<b>bold</b> https://example.org' })],
    });
    const li = target.querySelector('[data-live-chat-line]')!;
    expect(li.querySelector('b')).toBeNull();
    expect(li.querySelector('a')).toBeNull();
    expect(li.textContent).toContain('<b>bold</b> https://example.org');
    expect(li.textContent).toContain('Bob');
  });

  it('(f) isolates every name and text in its own bidi run, so a U+202E cannot reverse the line', () => {
    const { target } = render({ lines: [line({ text: '202Eevil' })] });
    const runs = target.querySelectorAll('[data-live-chat-line] bdi');
    expect(runs).toHaveLength(2);
    expect(runs[1].getAttribute('dir')).toBe('auto');
    expect(runs[1].textContent).toBe('202Eevil');
  });

  it('isolates each name and text in its own bidi run, so a U+202E cannot reverse the line', () => {
    const { target } = render({ lines: [line({ text: '‮evil' })] });
    const runs = target.querySelectorAll('[data-live-chat-line] bdi');
    expect(runs).toHaveLength(2);
    expect(runs[1].getAttribute('dir')).toBe('auto');
    expect(runs[1].textContent).toBe('‮evil');
  });

  it('names my own line "You"', () => {
    const { target } = render({ lines: [line({ authorId: ME, mine: true })] });
    expect(target.querySelector('[data-live-chat-line]')!.textContent).toContain(m.live_chat_you());
  });

  it('a moderator gets a hide button on each stored line, a viewer none', () => {
    const viewer = render({ lines: [line({})] });
    expect(viewer.target.querySelector('[data-live-chat-hide]')).toBeNull();
    unmount(app!);
    const mod = render({
      lines: [line({}), line({ id: null, clientId: 'c-2', status: 'pending', seq: null })],
      canModerate: true,
    });
    // The actions are behind a tap on the line (no always-visible eye-off): none before it.
    expect(mod.target.querySelector('[data-live-chat-hide]')).toBeNull();
    const toggles = mod.target.querySelectorAll<HTMLButtonElement>('[data-live-chat-line-toggle]');
    expect(toggles).toHaveLength(1);
    toggles[0].click();
    flushSync();
    const buttons = mod.target.querySelectorAll<HTMLButtonElement>('[data-live-chat-hide]');
    expect(buttons).toHaveLength(1);
    buttons[0].click();
    expect(mod.hide).toHaveBeenCalledWith('m-1');
  });

  it('a failed line says why; retry is offered for a network or rate failure only', () => {
    const { target, retry, discard } = render({
      lines: [
        line({
          id: null,
          clientId: 'c-n',
          mine: true,
          authorId: ME,
          status: 'failed',
          failure: 'network',
          seq: null,
        }),
        line({
          id: null,
          clientId: 'c-m',
          mine: true,
          authorId: ME,
          status: 'failed',
          failure: 'muted',
          seq: null,
        }),
      ],
    });
    const [network, muted] = target.querySelectorAll('[data-live-chat-line]');
    expect(network.textContent).toContain(m.live_chat_failed_network());
    expect(muted.textContent).toContain(m.live_chat_failed_muted());
    expect(muted.querySelector('[data-live-chat-retry]')).toBeNull();
    network.querySelector<HTMLButtonElement>('[data-live-chat-retry]')!.click();
    expect(retry).toHaveBeenCalledWith('c-n');
    muted.querySelector<HTMLButtonElement>('[data-live-chat-discard]')!.click();
    expect(discard).toHaveBeenCalledWith('c-m');
  });

  it('the composer sends the text and empties; no composer when one cannot write', async () => {
    const { target, send } = render();
    const input = target.querySelector<HTMLInputElement>('[data-live-chat-input]')!;
    expect(input.maxLength).toBe(300);
    input.value = 'salut';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    target.querySelector<HTMLFormElement>('[data-live-chat-composer]')!.requestSubmit();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('salut'));
    expect(input.value).toBe('');
    unmount(app!);
    const reader = render({ canWrite: false });
    expect(reader.target.querySelector('[data-live-chat-composer]')).toBeNull();
  });

  it('a too long refusal puts the text back with the reason', async () => {
    const { target } = render({ send: vi.fn(async () => 'too-long' as const), maxChars: 3 });
    const input = target.querySelector<HTMLInputElement>('[data-live-chat-input]')!;
    input.value = 'abc';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    target.querySelector<HTMLFormElement>('[data-live-chat-composer]')!.requestSubmit();
    await vi.waitFor(() =>
      expect(target.querySelector('[role="alert"]')?.textContent).toContain(
        m.live_chat_failed_too_long({ max: 3 })
      )
    );
    expect(input.value).toBe('abc');
  });
});

describe('LiveReactionsLayer', () => {
  it('never draws more than its cap of floats, whatever the burst', () => {
    const target = document.createElement('div');
    document.body.append(target);
    const layer = mount(LiveReactionsLayer, { target }) as unknown as {
      add(kind: string, n: number): void;
    };
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    layer.add('like', 100);
    flushSync();
    expect(target.querySelectorAll('[data-live-float]')).toHaveLength(24);
    layer.add('fire', 3);
    flushSync();
    expect(target.querySelectorAll('[data-live-float="fire"]')).toHaveLength(0);
    debug.mockRestore();
    unmount(layer as never);
  });
});

describe('LiveChatPanel report flag', () => {
  it("offers a flag on someone else's numbered line only, and calls back with the line", () => {
    const report = vi.fn();
    const theirs = line({ id: 'm-1', clientId: 'c-1' });
    const { target } = render({
      lines: [
        theirs,
        line({ id: 'm-2', clientId: 'c-2', authorId: ME, mine: true }),
        line({ id: null, clientId: 'c-3', status: 'pending' }),
      ],
      report,
    });
    const toggles = target.querySelectorAll<HTMLButtonElement>('[data-live-chat-line-toggle]');
    expect(toggles).toHaveLength(1);
    toggles[0].click();
    flushSync();
    const flags = target.querySelectorAll<HTMLButtonElement>('[data-live-chat-report]');
    expect(flags).toHaveLength(1);
    expect(flags[0].getAttribute('aria-label')).toBe(m.live_chat_report({ name: 'Bob' }));
    flags[0].click();
    expect(report).toHaveBeenCalledExactlyOnceWith(theirs);
  });

  it('draws no flag on a failed line of the reader', () => {
    const { target } = render({
      lines: [
        line({
          id: null,
          clientId: 'c-9',
          mine: true,
          authorId: ME,
          status: 'failed',
          failure: 'network',
        }),
      ],
      report: vi.fn(),
    });
    expect(target.querySelector('[data-live-chat-report]')).toBeNull();
  });

  it('draws no flag where reporting is not offered', () => {
    const { target } = render({ lines: [line({})] });
    expect(target.querySelector('[data-live-chat-report]')).toBeNull();
  });
});
