/**
 * A FAILED SALON SEND SHOWS ITS FAILURE WHEREVER IT IS, AND OFFERS RETRY AND DISCARD (WP-OFF-2).
 *
 * The status line used to appear only under the LAST own message: a refused message followed by a
 * later one would have read as delivered. An `error` is now shown on any own message, with the two
 * actions only when the caller provides them (a salon echo; a DM's failure stays a plain label).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageMetadata from './MessageMetadata.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MessageMetadata, {
    target,
    props: {
      isEdited: false,
      isOwn: true,
      isLastOwn: false,
      isReadReceiptAnchor: false,
      readBy: [],
      ...props,
    },
  });
  mounted.push(() => unmount(app));
  flushSync();
  return target;
}

describe('MessageMetadata on a failed send', () => {
  it('shows the failure even when it is not the last own message', () => {
    const target = render({ status: 'error' });
    expect(target.textContent).toContain('chec');
  });

  it('keeps a pending clock for the last own message only', () => {
    expect(render({ status: 'pending', isLastOwn: false }).textContent?.trim()).toBe('');
    expect(render({ status: 'pending', isLastOwn: true }).textContent).toBeTruthy();
  });

  it('calls retry and discard, and offers neither unless given', () => {
    const onRetry = vi.fn();
    const onDiscard = vi.fn();
    const target = render({ status: 'error', onRetry, onDiscard });

    target.querySelector<HTMLButtonElement>('[data-testid="message-retry"]')!.click();
    target.querySelector<HTMLButtonElement>('[data-testid="message-discard"]')!.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);

    const plain = render({ status: 'error' });
    expect(plain.querySelector('[data-testid="message-retry"]')).toBeNull();
  });
});
