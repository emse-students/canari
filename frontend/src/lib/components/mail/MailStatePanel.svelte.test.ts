// @vitest-environment happy-dom
/**
 * A MAIL SCREEN'S STATE (an error, an empty list, a closed mailbox): an error is an alert, anything
 * else a status, and "Réessayer" appears only when the screen offers a retry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type ComponentProps } from 'svelte';
import { TriangleAlert } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import { mailErrorText } from '$lib/mail/mailErrorText';
import MailStatePanel from './MailStatePanel.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(props: Record<string, unknown>): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MailStatePanel, {
    target,
    props: { Icon: TriangleAlert, ...props } as ComponentProps<typeof MailStatePanel>,
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

describe('MailStatePanel', () => {
  it('an error is announced as one, with a retry when offered', () => {
    const onRetry = vi.fn();
    const root = render({ tone: 'error', title: mailErrorText('transport'), onRetry });
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(mailErrorText('transport'));
    const retry = [...root.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === m.mail_retry()
    );
    retry!.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('an ordinary state is a status, with no retry', () => {
    const root = render({ title: m.mail_list_empty() });
    expect(root.querySelector('[role="status"]')).not.toBeNull();
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelectorAll('button')).toHaveLength(0);
  });
});
