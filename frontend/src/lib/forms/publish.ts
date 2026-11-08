import { m } from '$lib/paraglide/messages';
import type { Form } from './api';

/** The 409 refusing to publish a paid form whose association cannot collect yet (`forms.service.ts`). */
export const FORM_PAYMENTS_NOT_READY = 'FORM_PAYMENTS_NOT_READY';

/** The 400 refusing to attach a DRAFT form to a post or an agenda event (`form-status.ts`). */
export const FORM_IS_DRAFT = 'FORM_IS_DRAFT';

/** The 400 refusing a `draft` flag on an edit: publishing is its own route. */
export const FORM_DRAFT_FLAG_ON_EDIT = 'FORM_DRAFT_FLAG_ON_EDIT';

/** The 400 refusing to publish a paid form that accepts neither online nor cash. */
export const FORM_NO_PAYMENT_METHOD = 'FORM_NO_PAYMENT_METHOD';

/** The 409 refusing an online answer on a cash-only form. */
export const FORM_ONLINE_PAYMENT_NOT_OFFERED = 'FORM_ONLINE_PAYMENT_NOT_OFFERED';

/**
 * Whether `form` is a draft. A form from a server before drafts carries no status and is published,
 * so only the explicit `draft` counts.
 */
export function isDraftForm(form: Pick<Form, 'status'> | null | undefined): boolean {
  return form?.status === 'draft';
}

/** The forms another surface may point at (a post, an agenda event): never a draft. */
export function publishedForms<F extends Pick<Form, 'status'>>(forms: F[]): F[] {
  return forms.filter((f) => !isDraftForm(f));
}

/**
 * Why "Publier" is shut, as the sentence shown beside it, or `null` while it may be pressed - the
 * server's rule (`payment-offer.ts`, owner 2026-11-08): a PAID form is published when its
 * respondents can pay now, in cash (accepted) or online (accepted AND the association can collect).
 * Everything is built and saved as a draft whatever the readiness; only the publication waits.
 */
export function publishBlocker(state: {
  requiresPayment: boolean;
  associationId: string | null | undefined;
  associationCanBePaid: boolean;
  allowCashPayment: boolean;
  allowOnlinePayment: boolean;
}): string | null {
  if (!state.requiresPayment || !state.associationId || state.allowCashPayment) return null;
  if (!state.allowOnlinePayment) return m.form_no_payment_method();
  return state.associationCanBePaid ? null : m.form_publish_blocked_payments();
}

/** The sentence for a refusal of the draft and publish routes, or `null` for another code. */
export function draftRefusalMessage(code: string | null | undefined): string | null {
  switch (code) {
    case FORM_PAYMENTS_NOT_READY:
      return m.form_publish_blocked_payments();
    case FORM_IS_DRAFT:
      return m.form_is_draft_refusal();
    case FORM_DRAFT_FLAG_ON_EDIT:
      return m.form_draft_flag_on_edit();
    case FORM_NO_PAYMENT_METHOD:
      return m.form_no_payment_method();
    case FORM_ONLINE_PAYMENT_NOT_OFFERED:
      return m.form_online_payment_not_offered();
    default:
      return null;
  }
}

/** The query flag that opens the fill page as a PREVIEW: the content shown, nothing sent. */
export const FORM_PREVIEW_PARAM = 'preview';

/**
 * Where "Voir le formulaire" leads (owner, 2026-11-08): the respondent view of a published form
 * with nothing unpublished, else a PREVIEW of what the managers are building - a draft form, or a
 * published form holding an unpublished draft revision (`hasUnpublishedChanges`). Opened in a new
 * tab by both callers (the forms list, the editor).
 */
export function formViewHref(
  form: { id: string; status?: Form['status'] },
  hasUnpublishedChanges = false
): string {
  const path = `/forms/${encodeURIComponent(form.id)}`;
  return isDraftForm(form) || hasUnpublishedChanges ? `${path}?${FORM_PREVIEW_PARAM}=1` : path;
}

/** Whether the fill page was opened as a preview: asked by the link, or the form is a draft. */
export function isPreview(
  form: Pick<Form, 'status'> | null | undefined,
  params: Pick<URLSearchParams, 'get'>
): boolean {
  return isDraftForm(form) || params.get(FORM_PREVIEW_PARAM) === '1';
}

/**
 * Whether a respondent is offered CASH ONLY now: online is paused (the editor took it off, or the
 * association cannot collect yet - `paymentsPaused`, served by the server) and the form takes cash.
 * The page then shows no online choice at all - never a dead Lydia button - and online comes back by
 * itself on the read after the association becomes ready (owner, 2026-11-08).
 */
export function offersOnlyCash(
  form: Pick<Form, 'paymentsPaused' | 'allowCashPayment'> | null | undefined
): boolean {
  return !!form?.paymentsPaused && !!form?.allowCashPayment;
}
