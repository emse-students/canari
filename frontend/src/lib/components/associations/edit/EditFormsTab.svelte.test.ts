// @vitest-environment happy-dom
/**
 * A CASH ANSWER FROM A GUEST, AWAITING VALIDATION, IS NAMED - IT DOES NOT CRASH THE TAB. A guest's
 * answer from a public form's link has no account (`userId` null); the pending-cash row named its
 * submitter by account id alone, so one guest paying cash threw `null.trim()` and turned the whole
 * Formulaires section into a 500 (read on dev, 2026-11-07). The row is named by `submitterName`,
 * the one rule the responses screen already follows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Association, AssociationForm } from '$lib/associations/api';
import type { PendingCashSubmission } from '$lib/forms/api';
import { m } from '$lib/paraglide/messages';
import { flushMacrotask } from '../../../../test/flush';

const state = vi.hoisted(() => ({
  forms: [] as unknown[],
  pending: [] as unknown[],
}));

vi.mock('$lib/associations/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/associations/api')>()),
  listAssociationForms: vi.fn(() => Promise.resolve(state.forms)),
}));

vi.mock('$lib/forms/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/forms/api')>()),
  listPendingCashSubmissions: vi.fn(() => Promise.resolve(state.pending)),
}));

import EditFormsTab from './EditFormsTab.svelte';

const asso = { id: 'asso-1', slug: 'club' } as unknown as Association;

function form(): AssociationForm {
  return {
    id: 'form-1',
    title: 'Merch',
    basePrice: 2800,
    allowCashPayment: true,
  } as unknown as AssociationForm;
}

function pendingRow(over: Partial<PendingCashSubmission>): PendingCashSubmission {
  return {
    id: 'sub-1',
    formId: 'form-1',
    userId: null,
    email: null,
    answers: {},
    totalPaid: 2700,
    paymentStatus: 'pending_cash',
    createdAt: '2026-11-07T10:00:00.000Z',
    ...over,
  };
}

let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

async function render(): Promise<HTMLElement> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(EditFormsTab, {
    target,
    props: {
      asso,
      onlinePaymentsReady: true,
      canManagePayoutAccount: true,
      onGoToPayments: () => {},
    },
  });
  await flushMacrotask();
  await flushMacrotask();
  flushSync();
  return target;
}

describe('EditFormsTab - a guest paying cash', () => {
  it('names a guest with no name by the reference they were given', async () => {
    state.forms = [form()];
    state.pending = [pendingRow({ reference: '003A-5F0A' })];
    const target = await render();
    expect(target.textContent).toContain(
      m.form_submitter_guest_reference({ reference: '003A-5F0A' })
    );
  });

  it('names a guest by what they typed, beside the guest word and the reference', async () => {
    state.forms = [form()];
    state.pending = [
      pendingRow({ reference: '003A-5F0A', guestFirstName: 'Ada', guestLastName: 'Test' }),
    ];
    const target = await render();
    expect(target.textContent).toContain(
      `Ada Test (${m.form_submitter_guest_reference({ reference: '003A-5F0A' })})`
    );
  });
});
