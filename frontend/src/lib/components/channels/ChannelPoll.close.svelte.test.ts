// @vitest-environment happy-dom
/**
 * Closing a poll early asks through the APP's dialog (`showConfirm`), never `window.confirm`: on
 * Android the WebView draws the system's, with the phone's English "CANCEL" / "OK" under a French
 * sentence (Mi 9T reading of `v1.2.6-alpha.1`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const showConfirm = vi.hoisted(() => vi.fn());
vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm }));

import ChannelPoll from './ChannelPoll.svelte';
import { m } from '$lib/paraglide/messages';
import type { ChannelPollMeta, ChannelPollSpec } from '$lib/services/ChannelService';

const spec: ChannelPollSpec = {
  kind: 'poll',
  question: 'Quel jour ?',
  options: [
    { id: 'a', label: 'Jeudi' },
    { id: 'b', label: 'Vendredi' },
  ],
};

const meta: ChannelPollMeta = {
  optionIds: ['a', 'b'],
  multipleChoice: false,
  endsAt: null,
  votesByUser: {},
  closed: false,
};

const mounted: (() => void)[] = [];

function render(onClose: () => void): void {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ChannelPoll, {
    target,
    props: { spec, meta, currentUserId: 'u-me', canClose: true, onClose },
  });
  mounted.push(() => void unmount(app));
  flushSync();
}

function closeButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === m.channel_poll_close_button()
  );
  if (!button) throw new Error('no close button rendered');
  return button;
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
  showConfirm.mockReset();
  vi.unstubAllGlobals();
});

describe('ChannelPoll early close', () => {
  it("asks through the app's dialog and never the system's", async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirm);
    showConfirm.mockResolvedValueOnce(true);
    const onClose = vi.fn();
    render(onClose);

    closeButton().click();

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(showConfirm).toHaveBeenCalledWith(
      m.channel_poll_close_confirm(),
      expect.objectContaining({ confirmLabel: m.channel_poll_close_button(), danger: true })
    );
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('closes nothing when the confirmation is declined', async () => {
    showConfirm.mockResolvedValueOnce(false);
    const onClose = vi.fn();
    render(onClose);

    closeButton().click();

    await vi.waitFor(() => expect(showConfirm).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(onClose).not.toHaveBeenCalled();
    // The button is back as it was, not stuck on a "sending" label.
    expect(closeButton().disabled).toBe(false);
  });

  it('opens one dialog for a double tap', async () => {
    let answer: (ok: boolean) => void = () => {};
    showConfirm.mockReturnValueOnce(new Promise<boolean>((resolve) => (answer = resolve)));
    const onClose = vi.fn();
    render(onClose);

    closeButton().click();
    closeButton().click();
    answer(true);

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(showConfirm).toHaveBeenCalledTimes(1);
  });
});
