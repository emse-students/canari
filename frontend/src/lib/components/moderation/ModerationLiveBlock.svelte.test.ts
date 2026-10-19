/**
 * THE ADMIN QUEUE'S LIVE ROW (WP-L8, client half): what a moderator reads about a reported live,
 * and the one control that acts on it.
 *
 * Pinned here: the cut button exists only where a cut can still happen (`open`, `ended`), the
 * broadcaster's previous cuts are shown BEFORE the click and again on the confirmation step, the
 * cut goes through a reason and a confirmation (nothing is sent before the second press), the
 * server's refusals each get their own sentence by code, and a repeat (`newlyCut: false`) is handed
 * back to the page like a first cut. The live API is replaced by a fake: the contract itself is
 * `live/api.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { initHistoryOverlayStack } from '$lib/utils/historyOverlayStack';
import { m } from '$lib/paraglide/messages';
import { LIVE_CUT_DETAILS_MAX } from '$lib/live/constants';
import type { ReportedLive } from '$lib/moderation/api';
import type { LiveCutResult } from '$lib/live/types';

const { cutLive } = vi.hoisted(() => ({ cutLive: vi.fn() }));

vi.mock('$lib/live/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/live/api')>()),
  cutLive,
}));
vi.mock('$lib/utils/copyId', () => ({ copyId: vi.fn() }));

import { LiveRefusalError } from '$lib/live/api';
import ModerationLiveBlock from './ModerationLiveBlock.svelte';

const LIVE_ID = '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';

const mounted: (() => void)[] = [];
let stopHistoryStack: () => void;

beforeEach(() => {
  stopHistoryStack = initHistoryOverlayStack();
  vi.spyOn(history, 'back').mockImplementation(() => {});
  history.replaceState(null, '');
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  cutLive.mockReset();
  // happy-dom's `Animation.cancel()` rejects the animation it is asked to cancel, which Svelte's
  // transition teardown does not expect (the modal's open/close transition is not this test's
  // subject): stubbed so closing the dialog never throws an unhandled rejection.
  vi.spyOn(HTMLElement.prototype, 'animate').mockReturnValue({
    cancel: () => {},
    play: () => {},
    pause: () => {},
    finish: () => {},
    effect: null,
    finished: Promise.resolve(),
    onfinish: null,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Animation);
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  stopHistoryStack();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const openLive = (over: Partial<ReportedLive> = {}): ReportedLive => ({
  state: 'open',
  broadcasterId: 'u9',
  broadcasterName: 'Claire',
  associationId: null,
  startedAt: '2026-10-19T10:00:00.000Z',
  endedAt: null,
  endReason: null,
  cutReason: null,
  broadcasterCuts: 0,
  ...over,
});

function render(live: ReportedLive) {
  const onCut = vi.fn<(r: LiveCutResult) => void>();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ModerationLiveBlock, {
    target,
    props: {
      liveId: LIVE_ID,
      live,
      formatDate: (iso: string) => `d(${iso})`,
      reasonLabel: (code: string) => `reason(${code})`,
      onCut,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return { onCut, target };
}

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);

/** Lets the pending promise chain (the cut call and its state writes) settle. */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

/** Opens the dialog, picks a reason and goes to the confirmation step. */
function toConfirmation(reason = 'harassment') {
  q('[data-moderation-live-cut]')!.click();
  flushSync();
  q(`[data-live-cut-reason="${reason}"]`)!.click();
  flushSync();
  q('[data-live-cut-continue]')!.click();
  flushSync();
}

const result = (over: Partial<LiveCutResult> = {}): LiveCutResult => ({
  liveId: LIVE_ID,
  broadcasterId: 'u9',
  reason: 'harassment',
  cutAt: '2026-10-19T10:05:00.000Z',
  endReason: 'cut',
  newlyCut: true,
  priorCuts: 0,
  ...over,
});

describe('what the row states', () => {
  it('names the state, the broadcaster, the start and the live id', () => {
    const { target } = render(openLive());
    expect(target.querySelector('[data-moderation-live-state]')!.textContent).toContain(
      m.moderation_live_state_open()
    );
    expect(target.textContent).toContain(m.moderation_live_broadcaster_label({ name: 'Claire' }));
    expect(target.textContent).toContain(
      m.moderation_live_started_label({ date: 'd(2026-10-19T10:00:00.000Z)' })
    );
    expect(target.querySelector('[data-moderation-live-id]')!.textContent).toContain(LIVE_ID);
  });

  it("shows the broadcaster's previous cuts only when there are some", () => {
    expect(render(openLive()).target.querySelector('[data-moderation-live-prior]')).toBeNull();
    document.body.innerHTML = '';
    const { target } = render(openLive({ broadcasterCuts: 3 }));
    expect(target.querySelector('[data-moderation-live-prior]')!.textContent).toContain(
      m.moderation_live_prior_cuts({ count: 3 })
    );
  });

  it.each([
    ['open', true],
    ['ended', true],
    ['cut', false],
    ['gone', false],
  ] as const)('a %s live shows the cut button: %s', (state, shown) => {
    const { target } = render(openLive({ state }));
    expect(target.querySelector('[data-moderation-live-cut]') !== null).toBe(shown);
  });

  it('a cut live names the reason it was cut for', () => {
    const { target } = render(openLive({ state: 'cut', cutReason: 'spam', endReason: 'cut' }));
    expect(target.querySelector('[data-moderation-live-cut-reason]')!.textContent).toContain(
      m.moderation_live_cut_reason_label({ reason: 'reason(spam)' })
    );
  });
});

describe('the cut', () => {
  it('sends nothing before the confirmation, then sends the reason and the details once', async () => {
    cutLive.mockResolvedValue(result({ priorCuts: 1 }));
    const { onCut } = render(openLive({ broadcasterCuts: 1 }));
    toConfirmation('harassment');
    expect(cutLive).not.toHaveBeenCalled();
    expect(q('[data-live-cut-confirm]')!.textContent).toContain(
      m.moderation_live_cut_confirm_body({ name: 'Claire' })
    );
    // The repeat count is on the step where the decision is taken.
    expect(q('[data-live-cut-prior]')!.textContent).toContain(
      m.moderation_live_prior_cuts({ count: 1 })
    );
    q('[data-live-cut-confirm-button]')!.click();
    await settle();
    expect(cutLive).toHaveBeenCalledTimes(1);
    expect(cutLive).toHaveBeenCalledWith(LIVE_ID, 'harassment', undefined);
    expect(onCut).toHaveBeenCalledWith(result({ priorCuts: 1 }));
  });

  it('carries the details when the moderator wrote some', async () => {
    cutLive.mockResolvedValue(result());
    render(openLive());
    q('[data-moderation-live-cut]')!.click();
    flushSync();
    q('[data-live-cut-reason="other"]')!.click();
    const details = q<HTMLTextAreaElement>('[data-live-cut-details]')!;
    details.value = '  looped a stolen video  ';
    details.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    q('[data-live-cut-continue]')!.click();
    flushSync();
    q('[data-live-cut-confirm-button]')!.click();
    await settle();
    expect(cutLive).toHaveBeenCalledWith(LIVE_ID, 'other', 'looped a stolen video');
  });

  it('cannot continue with details over the cap, whatever put them there', () => {
    render(openLive());
    q('[data-moderation-live-cut]')!.click();
    flushSync();
    q('[data-live-cut-reason="other"]')!.click();
    const details = q<HTMLTextAreaElement>('[data-live-cut-details]')!;
    details.value = 'x'.repeat(LIVE_CUT_DETAILS_MAX + 1);
    details.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(q<HTMLButtonElement>('[data-live-cut-continue]')!.disabled).toBe(true);
    details.value = 'x'.repeat(LIVE_CUT_DETAILS_MAX);
    details.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(q<HTMLButtonElement>('[data-live-cut-continue]')!.disabled).toBe(false);
  });

  it('cannot continue without a reason', () => {
    render(openLive());
    q('[data-moderation-live-cut]')!.click();
    flushSync();
    expect(q<HTMLButtonElement>('[data-live-cut-continue]')!.disabled).toBe(true);
  });

  it('a repeat is handed back like a first cut, so the page can say it was already done', async () => {
    cutLive.mockResolvedValue(result({ newlyCut: false, priorCuts: 2 }));
    const { onCut } = render(openLive({ state: 'ended', broadcasterCuts: 3 }));
    toConfirmation();
    q('[data-live-cut-confirm-button]')!.click();
    await settle();
    expect(onCut).toHaveBeenCalledWith(expect.objectContaining({ newlyCut: false }));
  });

  it.each([
    [
      '403 LIVE_CUT_FORBIDDEN',
      403,
      'LIVE_CUT_FORBIDDEN',
      'refused',
      'moderation_live_cut_forbidden',
    ],
    ['404 LIVE_NOT_FOUND', 404, 'LIVE_NOT_FOUND', 'not-found', 'moderation_live_cut_not_found'],
    ['400 reason', 400, 'LIVE_CUT_REASON_INVALID', 'refused', 'moderation_live_cut_invalid'],
    ['400 details', 400, 'LIVE_CUT_DETAILS_INVALID', 'refused', 'moderation_live_cut_invalid'],
    ['500 no code', 500, null, 'unavailable', 'moderation_live_cut_error'],
  ] as const)(
    '%s says its own sentence and returns to the form',
    async (_n, status, code, kind, key) => {
      cutLive.mockRejectedValue(new LiveRefusalError(status, code, '', kind, null, null, null));
      const { onCut } = render(openLive());
      toConfirmation();
      q('[data-live-cut-confirm-button]')!.click();
      await settle();
      expect(q('[data-live-cut-error]')!.textContent).toContain(m[key]());
      expect(onCut).not.toHaveBeenCalled();
      expect(q('[data-live-cut-step]')!.dataset.liveCutStep).toBe('pick');
    }
  );
});
