// @vitest-environment happy-dom
/**
 * AN UNKNOWN OUTCOME CLOSES THE BLOCK SHEET (review of #2035). The first block may have landed
 * after a lost answer, so the sheet re-reads the grid, says so, and closes (a second tap would be
 * refused `block-overlap`, which also closes it). A plain refusal (a 4xx, even with no code) keeps
 * it open with its sentence and re-reads nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const addBlock = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());
const namedSpaceBookings = vi.hoisted(() => vi.fn());

vi.mock('$lib/bookings/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/bookings/api')>()),
  addBlock: (...a: unknown[]) => addBlock(...a),
  namedSpaceBookings: (...a: unknown[]) => namedSpaceBookings(...a),
}));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import { setLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import { BookingsApiError, type BookerResource, type BookerSpace } from '$lib/bookings/api';
import BlockSheet from './BlockSheet.svelte';

const startMs = Date.parse('2026-11-02T09:00:00Z');
const space = { id: 'space-1', timeZone: 'Europe/Paris' } as unknown as BookerSpace;
const resource = { id: 'resource-1', name: 'Salle' } as unknown as BookerResource;
const run = [{ date: '2026-11-02', startMs, endMs: startMs + 30 * 60_000, state: 'free' as const }];

const mounted: ReturnType<typeof mount>[] = [];

function render(canManage = false) {
  const onReread = vi.fn(() => Promise.resolve());
  const onClose = vi.fn();
  mounted.push(
    mount(BlockSheet, {
      target: document.body,
      props: { space: { ...space, canManage }, resource, run, onReread, onClose },
    })
  );
  flushSync();
  return { onReread, onClose };
}

function submit() {
  const button = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === m.bookings_block_action()
  );
  if (!button) throw new Error('no block button');
  button.click();
}

beforeEach(() => {
  setLocale('en', { reload: false });
  addBlock.mockReset();
  namedSpaceBookings.mockReset();
  showToast.mockReset();
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

describe('BlockSheet after a failed write', () => {
  it('re-reads, says so and closes when nobody answered', async () => {
    addBlock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { onReread, onClose } = render();
    submit();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(false));
    expect(onReread).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(m.bookings_block_outcome_unknown(), 'error');
  });

  it('closes the same way on a 5xx with no code', async () => {
    addBlock.mockRejectedValue(new BookingsApiError('gateway', null, 504, []));
    const { onReread, onClose } = render();
    submit();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(false));
    expect(onReread).toHaveBeenCalledTimes(1);
  });

  it('stays open on a validation 400 with no code: nothing was written', async () => {
    addBlock.mockRejectedValue(new BookingsApiError('bad body', null, 400, []));
    const { onReread, onClose } = render();
    submit();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain(
      m.bookings_block_outcome_unknown()
    );
    expect(onReread).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('BlockSheet over a block that already exists', () => {
  it('says so, and closes asking for a re-read of the grid', async () => {
    addBlock.mockRejectedValue(new BookingsApiError('overlap', 'block-overlap', 409, []));
    const { onClose } = render();
    submit();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(showToast).toHaveBeenCalledWith(m.bookings_refusal_block_overlap(), 'error');
  });
});

describe('BlockSheet over bookings the server named (D29)', () => {
  const named = new BookingsApiError('inside', 'bookings-inside-block', 409, ['b1']);
  const booking = {
    id: 'b1',
    resourceId: 'resource-1',
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(startMs + 30 * 60_000).toISOString(),
    cancelled: false,
    holderName: 'Camille',
  };

  it('lists them for a manager, keeps the sheet open and re-reads the grid', async () => {
    addBlock.mockRejectedValue(named);
    namedSpaceBookings.mockResolvedValue([booking]);
    const { onReread, onClose } = render(true);
    submit();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Camille'));
    expect(namedSpaceBookings).toHaveBeenCalledWith('space-1', ['b1']);
    expect(document.querySelector('section[aria-label]')?.getAttribute('aria-label')).toBe(
      m.bookings_stranded_title()
    );
    expect(onReread).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('keeps the count and closes for an account that may not read the space bookings', async () => {
    addBlock.mockRejectedValue(named);
    const { onClose } = render(false);
    submit();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(namedSpaceBookings).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(m.bookings_refusal_inside_block({ count: 1 }), 'error');
  });
});
