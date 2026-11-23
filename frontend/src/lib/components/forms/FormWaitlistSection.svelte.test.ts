// @vitest-environment happy-dom
/**
 * THE WAITING LIST ON THE RESPONSES SCREEN (owner decision of 2026-11-23): the waiting answers are
 * drawn apart from the registrations, in arrival order and never counted with them; "Inscrire"
 * promotes one by hand after a confirmation, "Retirer" is the ordinary deletion.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import type { Form, Submission } from '$lib/forms/api';
import { m } from '$lib/paraglide/messages';

const calls = vi.hoisted(() => ({ promoted: [] as string[][], confirm: true }));

vi.mock('$lib/associations/api', () => ({
  listAssociationPurchases: vi.fn(async () => []),
  listAssociationRefunds: vi.fn(async () => ({ standings: [], refunds: [] })),
}));
vi.mock('$lib/forms/api', async (original) => ({
  ...(await original<typeof import('$lib/forms/api')>()),
  promoteFromWaitlist: vi.fn(async (formId: string, submissionId: string) => {
    calls.promoted.push([formId, submissionId]);
  }),
}));
vi.mock('$lib/stores/confirm.svelte', () => ({
  showConfirm: () => Promise.resolve(calls.confirm),
}));

import FormResponsesPanel from './FormResponsesPanel.svelte';

const mounted: (() => void)[] = [];

beforeEach(() => {
  calls.promoted = [];
  calls.confirm = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const form = {
  id: 'f1',
  title: 'Soiree',
  items: [{ id: 'q', label: 'Regime', required: false, type: 'short_text' }],
  requiresPayment: false,
  maxSubmissions: 1,
  waitlistEnabled: true,
  createdAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-20T10:00:00.000Z',
} as unknown as Form;

const sub = (over: Partial<Submission>): Submission => ({
  id: 's',
  formId: 'f1',
  userId: 'u1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: null,
  answers: { q: 'aucun' },
  totalPaid: 0,
  paymentStatus: 'free',
  createdAt: '2026-11-20T10:00:00.000Z',
  ...over,
});

const SUBMISSIONS: Submission[] = [
  sub({ id: 'registered' }),
  // Listed out of order on purpose: the screen sorts by the server's arrival order.
  sub({
    id: 'second',
    userId: 'u3',
    firstName: 'Grace',
    lastName: 'Hopper',
    paymentStatus: 'waiting',
    waitlistOrder: '9',
  }),
  sub({
    id: 'first',
    userId: 'u2',
    firstName: 'Alan',
    lastName: 'Turing',
    paymentStatus: 'waiting',
    waitlistOrder: '3',
  }),
];

async function render(onDelete = vi.fn(), onReload = vi.fn(async () => {})) {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(FormResponsesPanel, {
    target,
    props: { form, submissions: SUBMISSIONS, deletingId: null, onDelete, onReload },
  });
  mounted.push(() => unmount(instance));
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
  return { target, onDelete, onReload };
}

const section = () => document.querySelector('[data-testid="form-waitlist-section"]');
const rows = () => [...document.querySelectorAll('[data-testid="form-waitlist-row"]')];
const buttonIn = (el: Element, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;

describe('the waiting list on the responses screen', () => {
  it('lists the waiting answers apart, in arrival order, with their count', async () => {
    await render();
    expect(section()!.textContent).toContain(m.form_waitlist_section_title({ count: 2 }));
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('Turing'),
      expect.stringContaining('Hopper'),
    ]);
  });

  it('never counts a waiting answer among the registrations', async () => {
    const { target } = await render();
    const table = target.querySelector('table');
    expect(table?.textContent ?? '').toContain('Lovelace');
    expect(table?.textContent ?? '').not.toContain('Turing');
  });

  it('promotes one by hand on a confirmed tap, then reads the answers again', async () => {
    const { onReload } = await render();
    buttonIn(rows()[1], m.form_waitlist_promote_button()).click();
    for (let i = 0; i < 6; i++) {
      await tick();
      await Promise.resolve();
    }
    expect(calls.promoted).toEqual([['f1', 'second']]);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('promotes nobody when the manager does not confirm', async () => {
    calls.confirm = false;
    await render();
    buttonIn(rows()[0], m.form_waitlist_promote_button()).click();
    for (let i = 0; i < 6; i++) await tick();
    expect(calls.promoted).toEqual([]);
  });

  it('removes one through the ordinary deletion', async () => {
    const { onDelete } = await render();
    buttonIn(rows()[0], m.form_waitlist_remove_button()).click();
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'first' }));
  });
});
