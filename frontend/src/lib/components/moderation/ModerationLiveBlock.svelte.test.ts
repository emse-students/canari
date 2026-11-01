// @vitest-environment happy-dom
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
import type { LiveCutResult, LiveStanding, LiveWithdrawalResult } from '$lib/live/types';

const { cutLive, withdrawBroadcaster } = vi.hoisted(() => ({
  cutLive: vi.fn(),
  withdrawBroadcaster: vi.fn(),
}));

vi.mock('$lib/live/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/live/api')>()),
  cutLive,
  withdrawBroadcaster,
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
  withdrawBroadcaster.mockReset();
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
  broadcasterStanding: null,
  ...over,
});

const standingOf = (over: Partial<LiveStanding> = {}): LiveStanding => ({
  cutsOnRecord: 3,
  suspendedUntil: '2026-11-18T10:00:00.000Z',
  withdrawnAt: null,
  withdrawalDue: true,
  ...over,
});

function render(live: ReportedLive) {
  const onCut = vi.fn<(r: LiveCutResult) => void>();
  const onWithdrawn = vi.fn<(r: LiveWithdrawalResult) => void>();
  const onStale = vi.fn<() => void>();
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
      onWithdrawn,
      onStale,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return { onCut, onWithdrawn, onStale, target };
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
      m.moderation_live_cut_forbidden,
    ],
    ['404 LIVE_NOT_FOUND', 404, 'LIVE_NOT_FOUND', 'not-found', m.moderation_live_cut_not_found],
    ['400 reason', 400, 'LIVE_CUT_REASON_INVALID', 'refused', m.moderation_live_cut_invalid],
    ['400 details', 400, 'LIVE_CUT_DETAILS_INVALID', 'refused', m.moderation_live_cut_invalid],
    ['500 no code', 500, null, 'unavailable', m.moderation_live_cut_error],
  ] as const)(
    '%s says its own sentence and returns to the form',
    async (_n, status, code, kind, key) => {
      cutLive.mockRejectedValue(new LiveRefusalError(status, code, '', kind, null, null, null));
      const { onCut } = render(openLive());
      toConfirmation();
      q('[data-live-cut-confirm-button]')!.click();
      await settle();
      expect(q('[data-live-cut-error]')!.textContent).toContain(key());
      expect(onCut).not.toHaveBeenCalled();
      expect(q('[data-live-cut-step]')!.dataset.liveCutStep).toBe('pick');
    }
  );
});

describe("the broadcaster's standing and the withdrawal", () => {
  const withdrawal = (over: Partial<LiveWithdrawalResult> = {}): LiveWithdrawalResult => ({
    userId: 'u9',
    reason: 'harassment',
    withdrawnAt: '2026-10-21T10:00:00.000Z',
    newlyWithdrawn: true,
    cutsOnRecord: 3,
    ...over,
  });

  /** Opens the withdrawal dialog and picks a reason. */
  function toWithdrawForm(reason = 'harassment') {
    q('[data-moderation-live-withdraw]')!.click();
    flushSync();
    q(`[data-live-withdraw-reason="${reason}"]`)!.click();
    flushSync();
  }

  it('draws no standing without one', () => {
    const { target } = render(openLive());
    expect(target.querySelector('[data-moderation-live-standing]')).toBeNull();
    expect(target.querySelector('[data-moderation-live-withdraw]')).toBeNull();
  });

  it('states the ladder position, the suspension end and that the withdrawal is due', () => {
    const { target } = render(openLive({ broadcasterStanding: standingOf() }));
    expect(target.querySelector('[data-moderation-live-standing-cuts]')!.textContent).toContain(
      m.moderation_live_standing_cuts({ count: 3, required: 3, days: 90 })
    );
    expect(target.querySelector('[data-moderation-live-suspended]')!.textContent).toContain(
      m.moderation_live_standing_suspended({ date: 'd(2026-11-18T10:00:00.000Z)' })
    );
    expect(target.querySelector('[data-moderation-live-due]')).not.toBeNull();
    expect(target.querySelector('[data-moderation-live-withdraw]')).not.toBeNull();
  });

  it('offers no withdrawal below the cuts it needs', () => {
    const { target } = render(
      openLive({ broadcasterStanding: standingOf({ cutsOnRecord: 2, withdrawalDue: false }) })
    );
    expect(target.querySelector('[data-moderation-live-withdraw]')).toBeNull();
    expect(target.querySelector('[data-moderation-live-due]')).toBeNull();
  });

  it('shows a withdrawn right and no button to withdraw it again', () => {
    const { target } = render(
      openLive({
        broadcasterStanding: standingOf({
          withdrawnAt: '2026-10-20T08:00:00.000Z',
          withdrawalDue: false,
        }),
      })
    );
    expect(target.querySelector('[data-moderation-live-withdrawn]')!.textContent).toContain(
      m.moderation_live_standing_withdrawn({ date: 'd(2026-10-20T08:00:00.000Z)' })
    );
    expect(target.querySelector('[data-moderation-live-suspended]')).toBeNull();
    expect(target.querySelector('[data-moderation-live-withdraw]')).toBeNull();
  });

  it('is offered on a live that is gone: only the broadcaster is left to restrict', () => {
    const { target } = render(openLive({ state: 'gone', broadcasterStanding: standingOf() }));
    expect(target.querySelector('[data-moderation-live-withdraw]')).not.toBeNull();
    expect(target.querySelector('[data-moderation-live-cut]')).toBeNull();
  });

  it('sends nothing until a reason is picked, then the broadcaster, reason and details once', async () => {
    withdrawBroadcaster.mockResolvedValue(withdrawal());
    const { onWithdrawn } = render(openLive({ broadcasterStanding: standingOf() }));
    q('[data-moderation-live-withdraw]')!.click();
    flushSync();
    expect(q<HTMLButtonElement>('[data-live-withdraw-confirm-button]')!.disabled).toBe(true);
    q('[data-live-withdraw-reason="other"]')!.click();
    const details = q<HTMLTextAreaElement>('[data-live-withdraw-details]')!;
    details.value = ' third cut ';
    details.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(withdrawBroadcaster).not.toHaveBeenCalled();
    q('[data-live-withdraw-confirm-button]')!.click();
    await settle();
    expect(withdrawBroadcaster).toHaveBeenCalledTimes(1);
    expect(withdrawBroadcaster).toHaveBeenCalledWith('u9', 'other', 'third cut');
    expect(onWithdrawn).toHaveBeenCalledWith(withdrawal());
  });

  it('hands a repeat back like a first withdrawal', async () => {
    withdrawBroadcaster.mockResolvedValue(withdrawal({ newlyWithdrawn: false }));
    const { onWithdrawn } = render(openLive({ broadcasterStanding: standingOf() }));
    toWithdrawForm();
    q('[data-live-withdraw-confirm-button]')!.click();
    await settle();
    expect(onWithdrawn).toHaveBeenCalledWith(expect.objectContaining({ newlyWithdrawn: false }));
  });

  it('names a broadcaster with no display name by a generic string, never an empty one', () => {
    render(openLive({ broadcasterName: null, broadcasterStanding: standingOf() }));
    q('[data-moderation-live-withdraw]')!.click();
    flushSync();
    const body = q('[data-live-withdraw-body]')!.textContent ?? '';
    expect(body).toContain(
      m.moderation_live_withdraw_body({ name: m.moderation_live_withdraw_this_account() })
    );
    expect(body.trimStart()).toBe(body);
  });

  it('asks for the queue to be re-read only when the withdrawal was refused as not due', async () => {
    withdrawBroadcaster.mockRejectedValue(
      new LiveRefusalError(409, 'LIVE_WITHDRAWAL_NOT_DUE', '', 'refused', null, null, null)
    );
    const { onStale } = render(openLive({ broadcasterStanding: standingOf() }));
    toWithdrawForm();
    q('[data-live-withdraw-confirm-button]')!.click();
    await settle();
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(q('[data-live-withdraw-error]')!.textContent).toContain(
      m.moderation_live_withdraw_not_due()
    );
    withdrawBroadcaster.mockRejectedValue(
      new LiveRefusalError(403, 'LIVE_WITHDRAWAL_FORBIDDEN', '', 'refused', null, null, null)
    );
    q('[data-live-withdraw-confirm-button]')!.click();
    await settle();
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      '403 forbidden',
      403,
      'LIVE_WITHDRAWAL_FORBIDDEN',
      'refused',
      m.moderation_live_withdraw_forbidden,
    ],
    ['409 not due', 409, 'LIVE_WITHDRAWAL_NOT_DUE', 'refused', m.moderation_live_withdraw_not_due],
    ['400 reason', 400, 'LIVE_CUT_REASON_INVALID', 'refused', m.moderation_live_withdraw_invalid],
    [
      '400 account',
      400,
      'LIVE_ACCOUNT_INVALID',
      'refused',
      m.moderation_live_withdraw_account_invalid,
    ],
    ['500 no code', 500, null, 'unavailable', m.moderation_live_withdraw_error],
  ] as const)('%s says its own sentence and stays open', async (_n, status, code, kind, key) => {
    withdrawBroadcaster.mockRejectedValue(
      new LiveRefusalError(status, code, '', kind, null, null, null)
    );
    const { onWithdrawn } = render(openLive({ broadcasterStanding: standingOf() }));
    toWithdrawForm();
    q('[data-live-withdraw-confirm-button]')!.click();
    await settle();
    expect(q('[data-live-withdraw-error]')!.textContent).toContain(key());
    expect(onWithdrawn).not.toHaveBeenCalled();
    expect(q('[data-live-withdraw-dialog]')).not.toBeNull();
  });
});
