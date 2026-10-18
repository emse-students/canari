/** The mention a refused control action leaves on a message, and its Retry (WP-CONTROL-NOTICE). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ControlRefusedNotice from './ControlRefusedNotice.svelte';
import { clearControlRefusal, recordControlRefusal } from '$lib/utils/chat/controlRefusals.svelte';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
  clearControlRefusal('m1');
  vi.restoreAllMocks();
});

function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ControlRefusedNotice, { target, props: { messageId: 'm1' } });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

describe('ControlRefusedNotice', () => {
  it('shows nothing without a refusal', () => {
    expect(render().querySelector('[data-testid="control-refused-notice"]')).toBeNull();
  });

  it('names the refused act, and Retry removes it only once the queue took the act', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const retry = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    recordControlRefusal('m1', { kind: 'delete', retry });
    const target = render();
    expect(target.textContent).toContain(m.control_refused_delete());

    const button = () =>
      target.querySelector<HTMLButtonElement>('[data-testid="control-refused-retry"]')!;
    button().click();
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    flushSync();
    expect(button()).not.toBeNull();

    button().click();
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(2));
    flushSync();
    expect(target.querySelector('[data-testid="control-refused-notice"]')).toBeNull();
  });
});
