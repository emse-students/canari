// @vitest-environment happy-dom
/**
 * A PENDING SEND SAYS WHAT IT WAITS FOR (R05, 2026-11-09). Across a deploy the server answers "not
 * now" (502/503/504) and the send waits for it: the label says "waiting for the server", never a
 * failure; a send with no answer at all says "waiting for the network"; anything else keeps the
 * plain "en attente".
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
      isOwn: true,
      isLastOwn: true,
      isReadReceiptAnchor: false,
      readBy: [],
      status: 'pending',
      ...props,
    },
  });
  mounted.push(() => unmount(app));
  flushSync();
  return target;
}

const pendingText = (target: HTMLElement) =>
  target.querySelector('[data-testid="message-pending"]')?.textContent?.trim();

describe('MessageMetadata on a pending send', () => {
  it('says it waits for the SERVER when the server answered "not now" - and is no failure', () => {
    const target = render({ waitingOn: 'server' });
    expect(pendingText(target)).toBe(m.msg_waiting_for_server());
    expect(target.textContent).not.toContain(m.msg_echec());
    expect(target.querySelector('[data-testid="message-retry"]')).toBeNull();
  });

  it('says it waits for the NETWORK when nothing answered', () => {
    expect(pendingText(render({ waitingOn: 'network' }))).toBe(m.msg_waiting_for_network());
  });

  it('keeps the plain label when nothing says what it waits for', () => {
    expect(pendingText(render({}))).toBe(m.msg_en_attente());
    expect(pendingText(render({ waitingOn: null }))).toBe(m.msg_en_attente());
  });

  it('a real refusal is still the failure, whatever the wait was', () => {
    const target = render({ status: 'error', waitingOn: 'server' });
    expect(target.textContent).toContain(m.msg_echec());
    expect(pendingText(target)).toBeUndefined();
  });
});

describe('a salon text held for the server keeps its actions (review of #3189, D2)', () => {
  it('offers Retry and Discard on a pending row that was handed them, and each works', () => {
    const onRetry = vi.fn();
    const onDiscard = vi.fn();
    const target = render({ waitingOn: 'server', onRetry, onDiscard });
    expect(pendingText(target)).toContain(m.msg_waiting_for_server());
    (target.querySelector('[data-testid="message-retry"]') as HTMLButtonElement).click();
    (target.querySelector('[data-testid="message-discard"]') as HTMLButtonElement).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('a pending row handed no action shows none', () => {
    const target = render({ waitingOn: 'network' });
    expect(target.querySelector('[data-testid="message-retry"]')).toBeNull();
    expect(target.querySelector('[data-testid="message-discard"]')).toBeNull();
  });
});
