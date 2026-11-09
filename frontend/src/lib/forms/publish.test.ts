import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FORM_DRAFT_CONFLICT,
  FORM_DRAFT_EMPTY,
  FORM_DRAFT_INVALID,
  FORM_DRAFT_FLAG_ON_EDIT,
  FORM_IS_DRAFT,
  FORM_PAYMENTS_NOT_READY,
  FORM_NO_PAYMENT_METHOD,
  FORM_ONLINE_PAYMENT_NOT_OFFERED,
  draftRefusalMessage,
  formViewHref,
  isDraftForm,
  isPreview,
  offersOnlyCash,
  publishBlocker,
  publishPaymentRefusal,
  formChargesMoney,
  type PublishPaymentShape,
  publishedForms,
} from './publish';
import { m } from '$lib/paraglide/messages';

describe('drafts and their publication', () => {
  it('reads only an explicit `draft` as a draft: a server before drafts sends no status', () => {
    expect(isDraftForm({ status: 'draft' })).toBe(true);
    expect(isDraftForm({ status: 'published' })).toBe(false);
    expect(isDraftForm({})).toBe(false);
    expect(isDraftForm(null)).toBe(false);
  });

  it('never offers a draft to a post or an agenda event', () => {
    const forms = [
      { id: 'a', status: 'draft' as const },
      { id: 'b', status: 'published' as const },
      { id: 'c' },
    ];
    expect(publishedForms(forms).map((f) => f.id)).toEqual(['b', 'c']);
  });

  it('shuts "Publier" only when the respondents could not pay now (ready OR cash, owner 2026-11-08)', () => {
    const paid = { requiresPayment: true, allowCashPayment: false, allowOnlinePayment: true };
    const base = { form: paid, associationId: 'a1', associationCanBePaid: false };
    expect(publishBlocker(base)).toBe(m.form_publish_blocked_payments());
    // Cash accepted: publishable while online is not ready.
    expect(publishBlocker({ ...base, form: { ...paid, allowCashPayment: true } })).toBeNull();
    expect(publishBlocker({ ...base, associationCanBePaid: true })).toBeNull();
    // Neither online nor cash: a paid form nobody could pay.
    expect(
      publishBlocker({
        ...base,
        associationCanBePaid: true,
        form: { ...paid, allowOnlinePayment: false },
      })
    ).toBe(m.form_no_payment_method());
    expect(publishBlocker({ ...base, form: { requiresPayment: false } })).toBeNull();
    // A choice supplement charges without the switch, as on the server.
    expect(
      publishBlocker({
        ...base,
        form: {
          requiresPayment: false,
          items: [{ type: 'single_choice', options: [{ priceModifier: 300 }] }],
        },
      })
    ).toBe(m.form_publish_blocked_payments());
    // A personal form collects through the platform: online is ready, a way to pay is still owed.
    expect(publishBlocker({ ...base, associationId: '' })).toBeNull();
    expect(
      publishBlocker({ ...base, associationId: '', form: { ...paid, allowOnlinePayment: false } })
    ).toBe(m.form_no_payment_method());
  });

  it('agrees with the server on every case of libs/contracts/form-publish-payment.cases.json', () => {
    const { cases } = JSON.parse(
      readFileSync(
        join(process.cwd(), '..', 'libs', 'contracts', 'form-publish-payment.cases.json'),
        'utf8'
      )
    ) as {
      cases: {
        name: string;
        form: PublishPaymentShape;
        onlineReady: boolean;
        charges: boolean;
        expected: string | null;
      }[];
    };
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect([c.name, formChargesMoney(c.form)]).toEqual([c.name, c.charges]);
      const refusal = formChargesMoney(c.form)
        ? publishPaymentRefusal(c.form, c.onlineReady)
        : null;
      expect([c.name, refusal]).toEqual([c.name, c.expected]);
    }
  });

  it('leads "Voir le formulaire" to the live page, or to a preview while anything is unpublished', () => {
    expect(formViewHref({ id: 'f1', status: 'published' })).toBe('/forms/f1');
    expect(formViewHref({ id: 'f1' })).toBe('/forms/f1');
    expect(formViewHref({ id: 'f1', status: 'draft' })).toBe('/forms/f1?preview=1');
    expect(formViewHref({ id: 'f1', status: 'published' }, true)).toBe('/forms/f1?preview=1');
    expect(isPreview({ status: 'draft' })).toBe(true);
    // A published form is a preview only when a manager's revision is what is shown.
    expect(isPreview({ status: 'published' })).toBe(false);
    expect(isPreview({ status: 'published' }, true)).toBe(true);
  });

  it('offers cash only while online is paused and cash is accepted', () => {
    expect(offersOnlyCash({ paymentsPaused: true, allowCashPayment: true })).toBe(true);
    expect(offersOnlyCash({ paymentsPaused: true, allowCashPayment: false })).toBe(false);
    expect(offersOnlyCash({ paymentsPaused: false, allowCashPayment: true })).toBe(false);
  });

  it('words every draft refusal the server types, and nothing else', () => {
    expect(draftRefusalMessage(FORM_PAYMENTS_NOT_READY)).toBe(m.form_publish_blocked_payments());
    expect(draftRefusalMessage(FORM_IS_DRAFT)).toBe(m.form_is_draft_refusal());
    expect(draftRefusalMessage(FORM_DRAFT_FLAG_ON_EDIT)).toBe(m.form_draft_flag_on_edit());
    expect(draftRefusalMessage(FORM_NO_PAYMENT_METHOD)).toBe(m.form_no_payment_method());
    expect(draftRefusalMessage(FORM_ONLINE_PAYMENT_NOT_OFFERED)).toBe(
      m.form_online_payment_not_offered()
    );
    expect(draftRefusalMessage(FORM_DRAFT_CONFLICT)).toBe(m.form_draft_conflict_refusal());
    expect(draftRefusalMessage(FORM_DRAFT_EMPTY)).toBe(m.form_draft_empty_refusal());
    expect(draftRefusalMessage(FORM_DRAFT_INVALID)).toBe(m.form_draft_invalid_refusal());
    expect(draftRefusalMessage('SOMETHING_ELSE')).toBeNull();
    expect(draftRefusalMessage(null)).toBeNull();
  });
});
