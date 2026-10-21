import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('$lib/stores/auth', () => ({ getToken: async () => 'tok' }));
vi.mock('$lib/utils/apiUrl', () => ({ socialUrl: () => 'http://social' }));

import { refusalCode, refusalStatus } from '$lib/utils/apiRefusal';
import { getForms, deleteForm, listPendingCashSubmissions, submitForm } from './api';
import { providerRefusalMessage } from '$lib/associations/paymentRefusal';
import { formatAmount } from './fillAnswers';
import { m } from '$lib/paraglide/messages';

/** A gateway answer: JSON body, JSON content type. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('every refused forms call is typed at the throw', () => {
  beforeEach(() => apiFetch.mockReset());

  it('carries the status and the server code of a JSON refusal', async () => {
    apiFetch.mockResolvedValue(json(403, { message: 'Forbidden', code: 'FORM_NOT_YOURS' }));
    const err = await deleteForm('f1').catch((e) => e);
    expect(refusalStatus(err)).toBe(403);
    expect(refusalCode(err)).toBe('FORM_NOT_YOURS');
  });

  it('carries the status and NO code when the body is the edge page, not the gateway', async () => {
    apiFetch.mockResolvedValue(
      new Response('<html>ban</html>', { status: 403, headers: { 'content-type': 'text/html' } })
    );
    const err = await getForms().catch((e) => e);
    expect(refusalStatus(err)).toBe(403);
    expect(refusalCode(err)).toBeNull();
  });

  it('keeps a status for a list read refused with a 5xx', async () => {
    apiFetch.mockResolvedValue(json(503, {}));
    const err = await listPendingCashSubmissions('f1').catch((e) => e);
    expect(refusalStatus(err)).toBe(503);
  });
});

describe('a refused form submission keeps the amount bounds the payment page words', () => {
  beforeEach(() => apiFetch.mockReset());

  it('an out-of-range amount reaches providerRefusalMessage with its bounds, not as prose', async () => {
    apiFetch.mockResolvedValue(
      json(400, {
        code: 'AMOUNT_OUT_OF_RANGE',
        message: 'Lydia accepts payments from 0.50 to 1000.00 EUR (got 1001.00)',
        minCents: 50,
        maxCents: 100000,
      })
    );
    const err = await submitForm('f1', { answers: {} }).catch((e) => e);
    expect(refusalCode(err)).toBe('AMOUNT_OUT_OF_RANGE');
    expect(providerRefusalMessage(err)).toBe(
      m.shop_payment_amount_range({ min: formatAmount(50), max: formatAmount(100000) })
    );
  });

  it('CONTROL: a refusal with no bounds leaves the page its own generic line', async () => {
    apiFetch.mockResolvedValue(json(400, { message: 'Answer required', code: 'OTHER' }));
    const err = await submitForm('f1', { answers: {} }).catch((e) => e);
    expect(refusalStatus(err)).toBe(400);
    expect(providerRefusalMessage(err)).toBeNull();
  });
});
