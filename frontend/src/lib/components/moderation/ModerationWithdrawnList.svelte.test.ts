// @vitest-environment happy-dom
/**
 * THE WITHDRAWN BROADCASTERS (1.7.0): the lift is reachable from a list read WITHOUT any report, so a
 * withdrawal whose reports are all handled is not stranded. Pinned: a row per account with its
 * reason, the lift goes through ONE confirmation and the typed refusal sentences, a repeat is handed
 * back like a first lift, and nothing is sent when the confirmation is declined.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import type { LiveBroadcasterStanding } from '$lib/live/types';

const { liftBroadcasterWithdrawal, showConfirm } = vi.hoisted(() => ({
  liftBroadcasterWithdrawal: vi.fn(),
  showConfirm: vi.fn(),
}));

vi.mock('$lib/live/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/live/api')>()),
  liftBroadcasterWithdrawal,
}));
vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm }));
vi.mock('$lib/components/shared/Avatar.svelte', async () => ({
  default: (await import('$lib/components/ui/Button.svelte')).default,
}));

import { LiveRefusalError } from '$lib/live/api';
import ModerationWithdrawnList from './ModerationWithdrawnList.svelte';

const row = (
  userId: string,
  over: Partial<LiveBroadcasterStanding> = {}
): LiveBroadcasterStanding => ({
  userId,
  displayName: `Name ${userId}`,
  cutsOnRecord: 3,
  suspendedUntil: null,
  withdrawnAt: '2026-11-10T10:00:00.000Z',
  withdrawalDue: false,
  withdrawalReason: 'harassment',
  ...over,
});

const mounted: (() => void)[] = [];

function render(rows: LiveBroadcasterStanding[], loading = false) {
  const onLifted = vi.fn();
  const target = document.createElement('div');
  document.body.append(target);
  const app = mount(ModerationWithdrawnList, {
    target,
    props: {
      rows,
      loading,
      formatDate: (iso: string) => `D(${iso.slice(0, 10)})`,
      reasonLabel: (code: string) => `R(${code})`,
      onLifted,
    },
  });
  flushSync();
  mounted.push(() => {
    unmount(app);
    target.remove();
  });
  return { target, onLifted };
}

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
};

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  liftBroadcasterWithdrawal.mockReset();
  showConfirm.mockReset();
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  vi.restoreAllMocks();
});

describe('ModerationWithdrawnList', () => {
  it('says so when nobody is withdrawn, and skeletons while loading', () => {
    const empty = render([]);
    expect(empty.target.querySelector('[data-moderation-withdrawn-empty]')).not.toBeNull();
    expect(empty.target.textContent).toContain(m.moderation_withdrawn_empty());
    const loading = render([], true);
    expect(loading.target.querySelector('[data-loading-skeleton]')).not.toBeNull();
    expect(loading.target.querySelector('[data-moderation-withdrawn-empty]')).toBeNull();
  });

  it('draws a row per account with its name, date and reason, and a lift on each', () => {
    const { target } = render([row('u1'), row('u2', { withdrawalReason: null })]);
    expect(target.querySelectorAll('[data-moderation-withdrawn-row]')).toHaveLength(2);
    expect(target.textContent).toContain('Name u1');
    expect(target.textContent).toContain(
      m.moderation_live_standing_withdrawn({ date: 'D(2026-11-10)' })
    );
    expect(target.querySelectorAll('[data-moderation-withdrawn-reason]')).toHaveLength(1);
    expect(target.textContent).toContain(
      m.moderation_withdrawn_reason({ reason: 'R(harassment)' })
    );
    expect(target.querySelectorAll('[data-moderation-live-lift]')).toHaveLength(2);
  });

  it('lifts after ONE confirmation naming the account, and hands the answer back', async () => {
    showConfirm.mockResolvedValue(true);
    liftBroadcasterWithdrawal.mockResolvedValue({ userId: 'u1', lifted: true });
    const { target, onLifted } = render([row('u1')]);
    target.querySelector<HTMLButtonElement>('[data-moderation-live-lift]')!.click();
    await tick();
    expect(showConfirm).toHaveBeenCalledTimes(1);
    expect(showConfirm.mock.calls[0][0]).toBe(m.moderation_live_lift_prompt({ name: 'Name u1' }));
    expect(liftBroadcasterWithdrawal).toHaveBeenCalledWith('u1');
    expect(onLifted).toHaveBeenCalledWith({ userId: 'u1', lifted: true });
  });

  it('sends nothing when the confirmation is declined', async () => {
    showConfirm.mockResolvedValue(false);
    const { target, onLifted } = render([row('u1')]);
    target.querySelector<HTMLButtonElement>('[data-moderation-live-lift]')!.click();
    await tick();
    expect(liftBroadcasterWithdrawal).not.toHaveBeenCalled();
    expect(onLifted).not.toHaveBeenCalled();
  });

  it('says the typed refusal in its own sentence, and a lost answer in the generic one', async () => {
    showConfirm.mockResolvedValue(true);
    const { target, onLifted } = render([row('u1')]);
    const click = async () => {
      target.querySelector<HTMLButtonElement>('[data-moderation-live-lift]')!.click();
      await tick();
      await tick();
    };
    liftBroadcasterWithdrawal.mockRejectedValueOnce(
      new LiveRefusalError(403, 'LIVE_WITHDRAWAL_FORBIDDEN', '', 'refused', null, null, null)
    );
    await click();
    expect(target.querySelector('[data-moderation-live-lift-error]')!.textContent).toContain(
      m.moderation_live_lift_forbidden()
    );
    liftBroadcasterWithdrawal.mockRejectedValueOnce(new Error('network'));
    await click();
    expect(target.querySelector('[data-moderation-live-lift-error]')!.textContent).toContain(
      m.moderation_live_lift_error()
    );
    expect(onLifted).not.toHaveBeenCalled();
  });
});
