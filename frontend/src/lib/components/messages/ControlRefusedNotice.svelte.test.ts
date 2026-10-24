// @vitest-environment happy-dom
/** The mention a refused control action leaves on a message, and its Retry (WP-CONTROL-NOTICE). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ControlRefusedNotice from './ControlRefusedNotice.svelte';
import {
  clearControlRefusal,
  forgetControlRefusals,
  loadControlRefusals,
  recordControlRefusal,
  setControlRetryExecutor,
  type ControlAct,
} from '$lib/utils/chat/controlRefusals.svelte';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
beforeEach(() => {
  localStorage.clear();
  loadControlRefusals('me');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
  setControlRetryExecutor(null);
  forgetControlRefusals();
  localStorage.clear();
  vi.restoreAllMocks();
});

function render(excerpt = 'see you at noon') {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ControlRefusedNotice, { target, props: { messageId: 'm1', excerpt } });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

const refuse = (act: ControlAct) =>
  recordControlRefusal('me', { conversationId: 'g1', messageId: 'm1', act });
const buttons = (target: HTMLElement) => [
  ...target.querySelectorAll<HTMLButtonElement>('[data-testid="control-refused-retry"]'),
];

describe('ControlRefusedNotice', () => {
  it('shows nothing without a refusal', () => {
    expect(render().querySelector('[data-testid="control-refused-notice"]')).toBeNull();
  });

  it('names the refused act, and Retry removes it only once the queue took the act', async () => {
    const act: ControlAct = { kind: 'delete' };
    const executor = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async () => {
        clearControlRefusal('me', 'm1', act);
        return true;
      });
    setControlRetryExecutor(executor);
    refuse(act);
    const target = render();
    expect(target.textContent).toContain(m.control_refused_delete());

    buttons(target)[0].click();
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1));
    flushSync();
    expect(buttons(target)).toHaveLength(1);

    buttons(target)[0].click();
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2));
    flushSync();
    expect(target.querySelector('[data-testid="control-refused-notice"]')).toBeNull();
  });

  it('shows every refused act of the message, each Retry named after its act and message', () => {
    refuse({ kind: 'reaction', emoji: '👍', remove: false, at: 1 });
    refuse({ kind: 'pin', pinned: true, at: 2 });
    const target = render();
    const [reaction, pin] = buttons(target);
    expect(buttons(target)).toHaveLength(2);
    expect(reaction.getAttribute('aria-label')).toBe(
      m.control_refused_retry_label({
        action: m.control_refused_reaction({ emoji: '👍' }),
        excerpt: 'see you at noon',
      })
    );
    expect(pin.getAttribute('aria-label')).toContain(m.control_refused_pin());
    // The hit area is the 44px touch target, not the text-xs line it sits on.
    expect(reaction.className).toContain('min-h-11');
  });

  it('a Retry that rejects is accused, not swallowed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    setControlRetryExecutor(vi.fn().mockRejectedValue(new Error('boom')));
    refuse({ kind: 'edit', editedAt: 1 });
    const target = render('');
    expect(buttons(target)[0].getAttribute('aria-label')).toBe(
      m.control_refused_retry_label_no_text({ action: m.control_refused_edit() })
    );
    buttons(target)[0].click();
    await vi.waitFor(() =>
      expect(err).toHaveBeenCalledWith(expect.stringContaining('retry of refused "edit"'))
    );
  });
});

describe('ControlRefusedNotice with no chat page registered', () => {
  it('disables Retry until a handler exists, then enables it', () => {
    refuse({ kind: 'delete' });
    const target = render();
    expect(buttons(target)[0].disabled).toBe(true);
    setControlRetryExecutor(vi.fn().mockResolvedValue(true));
    flushSync();
    expect(buttons(target)[0].disabled).toBe(false);
  });
});
