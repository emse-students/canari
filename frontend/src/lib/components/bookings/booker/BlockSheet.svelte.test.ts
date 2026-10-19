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

vi.mock('$lib/bookings/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/bookings/api')>()),
  addBlock: (...a: unknown[]) => addBlock(...a),
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

function render() {
  const onReread = vi.fn(() => Promise.resolve());
  const onClose = vi.fn();
  mounted.push(
    mount(BlockSheet, { target: document.body, props: { space, resource, run, onReread, onClose } })
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
