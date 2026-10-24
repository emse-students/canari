// @vitest-environment happy-dom
/**
 * The viewer's report control, mounted: visible to a viewer and never to the broadcaster, the posts'
 * reason dialog opened over the viewer's layer, each typed refusal told apart (already reported, live
 * gone, anything else keeps the dialog open), and the block offer - asked only after a FILED report,
 * confirmed before it blocks, closing the live when it does.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import LiveReportControl from './LiveReportControl.svelte';
import { ModerationApiError } from '$lib/moderation/api';
import type { LiveListItem } from '$lib/live/types';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The dialog's outro is a Web Animation happy-dom rejects on teardown.
afterAll(adoptTransitionAnimations());

const h = vi.hoisted(() => ({
  createReport: vi.fn(),
  blockUser: vi.fn(),
  showConfirm: vi.fn(),
  showToast: vi.fn(),
  userId: 'viewer-1' as string | null,
}));

vi.mock('$lib/moderation/api', async (orig) => ({
  ...(await orig<typeof import('$lib/moderation/api')>()),
  createReport: h.createReport,
}));
vi.mock('$lib/users/blocks', () => ({ blockUser: h.blockUser }));
vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm: h.showConfirm }));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: h.showToast }));
vi.mock('$lib/stores/user', () => ({ getSavedUserId: () => h.userId }));

const LIVE: LiveListItem = {
  id: '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b',
  broadcasterId: 'broadcaster-1',
  associationId: null,
  startedAt: '2026-10-19T10:00:00.000Z',
};

const mounted: Record<string, unknown>[] = [];
let onBlocked: () => void;

async function settle() {
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 10; j++) await Promise.resolve();
    await tick();
  }
  flushSync();
}

async function render() {
  onBlocked = vi.fn<() => void>();
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(LiveReportControl, { target, props: { live: LIVE, onBlocked } }));
  await settle();
}

const flag = () => document.querySelector<HTMLButtonElement>('[data-live-report]');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const click = async (el: Element | null | undefined) => {
  (el as HTMLElement).click();
  await settle();
};
const dialogButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (b) => b.textContent?.trim() === label
  );
const submitButton = () => dialogButton(m.report_dialog_submit_button());

/** Opens the dialog, picks a reason, sends. */
async function fileReport() {
  await render();
  await click(flag());
  await click(dialogButton(m.post_spam()));
  await click(submitButton());
}

const refusal = (status: number, code: string | null) =>
  new ModerationApiError(status, code, `moderation ${status}`);

beforeEach(() => {
  h.userId = 'viewer-1';
  h.createReport.mockReset().mockResolvedValue({});
  h.blockUser.mockReset().mockResolvedValue({ ok: true });
  h.showConfirm.mockReset().mockResolvedValue(false);
  h.showToast.mockReset();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('LiveReportControl', () => {
  it('shows a named flag button to a viewer, and nothing on the broadcaster own view', async () => {
    await render();
    expect(flag()).not.toBeNull();
    expect(flag()!.getAttribute('aria-label')).toBe(m.live_report_button());
    expect(flag()!.tagName).toBe('BUTTON');
    unmount(mounted.pop()!);
    document.body.innerHTML = '';
    h.userId = LIVE.broadcasterId;
    await render();
    expect(flag()).toBeNull();
    expect(dialog()).toBeNull();
  });

  it('opens the reason dialog on the critical layer, over the viewer', async () => {
    await render();
    expect(dialog()).toBeNull();
    await click(flag());
    expect(dialog()).not.toBeNull();
    expect(dialog()!.getAttribute('aria-label')).toBe(m.live_report_dialog_title());
    expect(dialog()!.parentElement!.className).toContain('z-(--z-critical)');
    // No reason chosen yet: nothing can be sent.
    expect(submitButton()!.disabled).toBe(true);
  });

  it('files a live report with the live id and the chosen reason, then offers the block', async () => {
    await fileReport();
    expect(h.createReport).toHaveBeenCalledExactlyOnceWith('live', LIVE.id, 'spam');
    expect(h.showToast).toHaveBeenCalledWith(m.live_report_done(), 'info');
    expect(dialog()).toBeNull();
    expect(h.showConfirm).toHaveBeenCalledExactlyOnceWith(
      m.live_report_block_prompt(),
      expect.objectContaining({ danger: true })
    );
    // Declined: nothing is blocked, the viewer stays.
    expect(h.blockUser).not.toHaveBeenCalled();
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it('blocks the broadcaster once confirmed, and leaves the live', async () => {
    h.showConfirm.mockResolvedValue(true);
    await fileReport();
    expect(h.blockUser).toHaveBeenCalledExactlyOnceWith(LIVE.broadcasterId);
    expect(h.showToast).toHaveBeenCalledWith(m.live_report_block_done(), 'info');
    expect(onBlocked).toHaveBeenCalledOnce();
  });

  it('a failed block says so and keeps the viewer in the live', async () => {
    h.showConfirm.mockResolvedValue(true);
    h.blockUser.mockRejectedValue(new Error('boom'));
    await fileReport();
    expect(h.showToast).toHaveBeenCalledWith(m.live_report_block_failed(), 'error');
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it('409 ALREADY_REPORTED thanks, closes, and offers no block', async () => {
    h.createReport.mockRejectedValue(refusal(409, 'ALREADY_REPORTED'));
    await fileReport();
    expect(h.showToast).toHaveBeenCalledWith(m.live_report_already(), 'info');
    expect(dialog()).toBeNull();
    expect(h.showConfirm).not.toHaveBeenCalled();
  });

  it('404 LIVE_NOT_FOUND says the live is gone, closes, and offers no block', async () => {
    h.createReport.mockRejectedValue(refusal(404, 'LIVE_NOT_FOUND'));
    await fileReport();
    expect(h.showToast).toHaveBeenCalledWith(m.live_report_gone(), 'info');
    expect(dialog()).toBeNull();
    expect(h.showConfirm).not.toHaveBeenCalled();
  });

  it('any other failure keeps the dialog open so the report can be sent again', async () => {
    h.createReport.mockRejectedValueOnce(refusal(500, null));
    await fileReport();
    expect(h.showToast).toHaveBeenCalledWith(m.live_report_failed(), 'error');
    expect(dialog()).not.toBeNull();
    expect(h.showConfirm).not.toHaveBeenCalled();
    await click(submitButton());
    expect(h.createReport).toHaveBeenCalledTimes(2);
    expect(dialog()).toBeNull();
  });

  it('a 404 that is not LIVE_NOT_FOUND is a plain failure, never "gone"', async () => {
    h.createReport.mockRejectedValue(refusal(404, null));
    await fileReport();
    expect(h.showToast).toHaveBeenCalledWith(m.live_report_failed(), 'error');
    expect(h.showToast).not.toHaveBeenCalledWith(m.live_report_gone(), 'info');
  });
});
