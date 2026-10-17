import { describe, expect, it } from 'vitest';
import { PAYMENT_STATUSES, statusClass, statusLabel, statusLabels } from './paymentStatus';
import { m } from '$lib/paraglide/messages';

describe('payment status labels', () => {
  it('names every status the server writes in words, never as the raw value', () => {
    for (const status of PAYMENT_STATUSES) expect(statusLabel(status)).not.toBe(status);
  });

  // The two states the seat hold introduced (2026-10-15): the online `pending` past its hold, and
  // the payment that landed after the form filled up.
  it('names an expired row and a payment over capacity', () => {
    expect(statusLabel('expired')).toBe(m.form_status_expired());
    expect(statusLabel('paid_over_capacity')).toBe(m.form_status_paid_over_capacity());
  });

  // The XLSX is written in the client's words: a status missing here is a raw enum in the file.
  it('sends a label for both to the export', () => {
    const labels = statusLabels();
    expect(labels.expired).toBe(m.form_status_expired());
    expect(labels.paid_over_capacity).toBe(m.form_status_paid_over_capacity());
  });

  it('does not colour a payment over capacity as settled', () => {
    expect(statusClass('paid_over_capacity')).not.toBe(statusClass('paid'));
  });

  it('returns an unknown status as itself', () => {
    expect(statusLabel('refunded')).toBe('refunded');
  });
});
