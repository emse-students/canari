// @vitest-environment happy-dom
/**
 * A RESTORED MESSAGE WHOSE AUTHOR NOTHING PROVES IS SHOWN, MARKED, AND EXPLAINED ON TAP.
 *
 * The message itself is drawn as any other; the marker is a small "non verifie" control under it,
 * and tapping it reveals why - without the tap reaching the bubble, which opens its own panel.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageMetadata from './MessageMetadata.svelte';
import { m } from '$lib/paraglide/messages';

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
      isOwn: false,
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

describe('MessageMetadata on a restored message with an unproven author', () => {
  it('shows the marker, and its explanation only once tapped', () => {
    const target = render({ restoredUnverified: true });
    const marker = target.querySelector<HTMLButtonElement>(
      'button[data-testid="message-restored-unverified"]'
    );
    expect(marker?.textContent?.trim()).toBe(m.msg_restored_unverified());
    expect(target.querySelector('[data-testid="message-restored-unverified-why"]')).toBeNull();
    expect(marker!.getAttribute('aria-expanded')).toBe('false');

    marker!.click();
    flushSync();

    const why = target.querySelector('[data-testid="message-restored-unverified-why"]');
    expect(why?.textContent?.trim()).toBe(m.msg_restored_unverified_hint());
    expect(marker!.getAttribute('aria-expanded')).toBe('true');

    marker!.click();
    flushSync();
    expect(target.querySelector('[data-testid="message-restored-unverified-why"]')).toBeNull();
  });

  it('keeps the tap from reaching the bubble', () => {
    const target = render({ restoredUnverified: true });
    const bubble = vi.fn();
    // On the mount target's parent: Svelte delegates its handlers to the mount target itself.
    document.body.addEventListener('click', bubble);
    target.querySelector<HTMLButtonElement>('[data-testid="message-restored-unverified"]')!.click();
    document.body.removeEventListener('click', bubble);
    expect(bubble).not.toHaveBeenCalled();
  });

  it('shows nothing for a message whose author is proven', () => {
    const target = render({ restoredUnverified: false });
    expect(target.querySelector('[data-testid="message-restored-unverified"]')).toBeNull();
  });
});
