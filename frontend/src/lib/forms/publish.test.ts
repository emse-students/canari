import { describe, expect, it } from 'vitest';
import {
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
    const base = {
      requiresPayment: true,
      associationId: 'a1',
      associationCanBePaid: false,
      allowCashPayment: false,
      allowOnlinePayment: true,
    };
    expect(publishBlocker(base)).toBe(m.form_publish_blocked_payments());
    // Cash accepted: publishable while online is not ready.
    expect(publishBlocker({ ...base, allowCashPayment: true })).toBeNull();
    expect(publishBlocker({ ...base, associationCanBePaid: true })).toBeNull();
    // Neither online nor cash: a paid form nobody could pay.
    expect(publishBlocker({ ...base, associationCanBePaid: true, allowOnlinePayment: false })).toBe(
      m.form_no_payment_method()
    );
    expect(publishBlocker({ ...base, requiresPayment: false })).toBeNull();
    // No association: the payment section refuses that case itself (`form_error_association_required`).
    expect(publishBlocker({ ...base, associationId: '' })).toBeNull();
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
    expect(draftRefusalMessage('SOMETHING_ELSE')).toBeNull();
    expect(draftRefusalMessage(null)).toBeNull();
  });
});
