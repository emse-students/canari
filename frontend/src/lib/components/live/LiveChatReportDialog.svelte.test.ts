// @vitest-environment happy-dom
/**
 * Reporting one live-chat line, mounted: the posts' reason dialog opens over the viewer's layer for a
 * numbered line only, the report carries the live, the message id, the reason and the plaintext the
 * reporter sees, and each typed refusal is told apart (already reported and live gone close the
 * dialog; anything else keeps it open to retry).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import LiveChatReportDialog from './LiveChatReportDialog.svelte';
import { ModerationApiError } from '$lib/moderation/api';
import type { LiveChatLine } from '$lib/live/liveChat';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

const h = vi.hoisted(() => ({ createLiveChatReport: vi.fn(), showToast: vi.fn() }));

vi.mock('$lib/moderation/api', async (orig) => ({
  ...(await orig<typeof import('$lib/moderation/api')>()),
  createLiveChatReport: h.createLiveChatReport,
}));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: h.showToast }));

const LIVE = '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';
const LINE: LiveChatLine = {
  id: 'm-7',
  clientId: 'c-7',
  authorId: 'b'.repeat(64),
  text: 'a rude line',
  seq: 7,
  status: 'sent',
  mine: false,
};

const mounted: Record<string, unknown>[] = [];
let onClose: () => void;

async function settle() {
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 10; j++) await Promise.resolve();
    await tick();
  }
  flushSync();
}

async function render(line: LiveChatLine | null) {
  onClose = vi.fn<() => void>();
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(LiveChatReportDialog, { target, props: { liveId: LIVE, line, onClose } }));
  await settle();
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (b) => b.textContent?.trim() === label
  );
const click = async (el: Element | null | undefined) => {
  (el as HTMLElement).click();
  await settle();
};

async function fileReport() {
  await render(LINE);
  await click(button(m.post_spam()));
  await click(button(m.report_dialog_submit_button()));
}

const refusal = (status: number, code: string | null) =>
  new ModerationApiError(status, code, `moderation ${status}`);

beforeEach(() => {
  h.createLiveChatReport.mockReset().mockResolvedValue({});
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

describe('LiveChatReportDialog', () => {
  it('is closed with no line, and open on the critical layer, naming the line, with one', async () => {
    await render(null);
    expect(dialog()).toBeNull();
    unmount(mounted.pop()!);
    await render(LINE);
    expect(dialog()!.getAttribute('aria-label')).toBe(m.live_chat_report_dialog_title());
    expect(dialog()!.parentElement!.className).toContain('z-(--z-critical)');
    expect(dialog()!.textContent).toContain('a rude line');
  });

  it('files the live, the message id, the reason and the plaintext, then closes', async () => {
    await fileReport();
    expect(h.createLiveChatReport).toHaveBeenCalledExactlyOnceWith({
      liveId: LIVE,
      messageId: 'm-7',
      reason: 'spam',
      message: 'a rude line',
    });
    expect(h.showToast).toHaveBeenCalledWith(m.live_chat_report_done(), 'info');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('says "already reported" and closes on 409 ALREADY_REPORTED', async () => {
    h.createLiveChatReport.mockRejectedValue(refusal(409, 'ALREADY_REPORTED'));
    await fileReport();
    expect(h.showToast).toHaveBeenCalledWith(m.live_chat_report_already(), 'info');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('says the live is over and closes on 404 LIVE_NOT_FOUND', async () => {
    h.createLiveChatReport.mockRejectedValue(refusal(404, 'LIVE_NOT_FOUND'));
    await fileReport();
    expect(h.showToast).toHaveBeenCalledWith(m.live_chat_report_gone(), 'info');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the dialog open with its own sentence for each typed 400/503 refusal', async () => {
    for (const [status, code, text] of [
      [400, 'LIVE_CHAT_REPORT_MISMATCH', m.live_chat_report_mismatch()],
      [400, 'LIVE_CHAT_REPORT_MESSAGE_INVALID', m.live_chat_report_too_long()],
      [503, 'LIVE_REPORT_SIGNING_UNAVAILABLE', m.live_chat_report_unavailable()],
    ] as const) {
      h.showToast.mockReset();
      h.createLiveChatReport.mockRejectedValue(refusal(status, code));
      await fileReport();
      expect(h.showToast).toHaveBeenCalledWith(text, 'error');
      expect(onClose).not.toHaveBeenCalled();
      expect(dialog()).not.toBeNull();
      unmount(mounted.pop()!);
      document.body.innerHTML = '';
    }
  });

  it('hands over a 400-character line whole: the client sets no bound below the server', async () => {
    const long = 'é'.repeat(400);
    await render({ ...LINE, text: long });
    await click(button(m.post_spam()));
    await click(button(m.report_dialog_submit_button()));
    expect(h.createLiveChatReport).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: long })
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the dialog open on any other failure, so the person can retry', async () => {
    h.createLiveChatReport.mockRejectedValue(refusal(500, null));
    await fileReport();
    expect(h.showToast).toHaveBeenCalledWith(m.live_chat_report_failed(), 'error');
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });
});
