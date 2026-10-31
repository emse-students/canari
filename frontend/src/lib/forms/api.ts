import { m } from '$lib/paraglide/messages';
import { statusLabels } from './paymentStatus';
import type { AnswerWords } from './answerText';
import type { PaymentRequestState } from './paymentReturn';

export interface FormOption {
  label: string;
  /**
   * Price modifier in cents, added when this option is selected.
   *
   * One modifier, not one per audience: who somebody is decides which CELL of the pricing grid they
   * land in, and a question the grid prices on adds no modifier at all - the cell already carries
   * that choice. See `priceMatrix.ts`.
   */
  priceModifier: number;
  id?: string;
}

export interface FormItem {
  id: string;
  label: string;
  /** Optional help text shown below the question label. */
  description?: string;
  required: boolean;
  type: string;
  options?: FormOption[];
  rows?: string[];
  scale?: {
    min: number;
    max: number;
    minLabel?: string;
    maxLabel?: string;
  };
  /** Optional image URL displayed above the input field. */
  imageUrl?: string;
  /** ID of the question this question depends on (branching logic). */
  dependsOn?: string;
  /** Option id that must be selected in the dependsOn question to show this one. */
  dependsValue?: string;
  /**
   * Show this question only to submitters matching these criteria - a cotisation tier, a promo, a
   * formation, or an answer to another question. The generalisation of the pair above, and the same
   * criteria shape the pricing grid is built from.
   */
  showIf?: AudienceCondition | null;
}

/** Cotisation tiers of the beneficiary association; `null` is the base tier. */
export interface CotisationCriterion {
  anyTier?: boolean;
  variantKeys?: (string | null)[];
}

/**
 * One set of criteria, ANDed across whatever is present; absent means no constraint.
 *
 * Mirrors the server's `forms/pricing/audience.ts`. Used for a question's visibility and for who may
 * submit at all - one shape, because it is one predicate on the server.
 */
export interface AudienceCondition {
  cotisation?: CotisationCriterion;
  /**
   * The person holds NONE of these tiers - "ne detient pas" (owner, 2026-10-30, so nobody pays a
   * cotisation twice). Its own key, never beside `cotisation` (the server refuses the pair): an
   * older editor spreads an unknown key through untouched, where it would have dropped a flag.
   * Judged by the server alone, like every profile criterion (`maySubmit`, `hiddenItemIds`).
   */
  notCotisation?: CotisationCriterion;
  /** Promos (ENTRY years) accepted - the promo 2024 entered the school in 2024. */
  promo?: { values: number[] };
  formation?: { values: string[] };
  answer?: { questionId: string; optionIds: string[] };
}

export interface CreateFormPayload {
  title: string;
  description?: string;
  basePrice: number;
  currency: string;
  items: FormItem[];
  maxSubmissions?: number;
  /** ISO 8601 - submissions blocked until this instant. */
  opensAt?: string;
  requiresPayment?: boolean;
  associationId?: string;
  paymentMethods?: string[];
  /** Allow the same user to submit multiple times (e.g. product orders). */
  allowMultipleSubmissions?: boolean;
  /**
   * Answers are stored without their author, address or exact time. Free forms only and fixed at
   * creation: the edit screen never sends it and shows it read-only.
   */
  anonymous?: boolean;
  /**
   * Answerable without an account from `/f/:id`. The server holds it to a free form with no
   * audience criterion that takes several answers - a guest has no identity for any of those.
   */
  isPublic?: boolean;
  /** Whether cash (physical) payment is accepted as an alternative to the online payment. */
  allowCashPayment?: boolean;
  /** Days after submission before an unvalidated cash payment expires (null = never). */
  cashPaymentExpiryDays?: number;
  /**
   * Days a FILE question's file is kept after each answer, 1 to 30, 7 by default. The answer stays;
   * the file is deleted by the server's purge (`form-file-retention.scheduler.ts`).
   */
  fileRetentionDays?: number;
  /**
   * The pricing grid: `{ dimensions, cells }` in cents, or null for one price for everybody.
   *
   * A matrix rather than a list of price rules, so exactly one cell applies to any person and there
   * is no priority rule anywhere in the feature. Built and read by `priceMatrix.ts`; the server
   * refuses an incomplete one.
   */
  priceMatrix?: unknown;
  /** Who may submit at all; null means anybody. Same criteria shape as a grid's groups. */
  submitCondition?: AudienceCondition | null;
  /**
   * When true, a paid submission grants `associationId`'s cotisation to the submitter - derived
   * server-side at grant time, with the sibling tiers revoked, exactly like a boutique purchase.
   * The frontend never computes a tag: see migration 050 for what a stored one cost.
   */
  grantsCotisation?: boolean;
  /** Which tier `grantsCotisation` grants; null = the base tier. */
  cotisationVariantKey?: string | null;
}

export interface Form extends CreateFormPayload {
  id: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Display name of the linked association, resolved server-side for the list.
   *
   * The list covers forms reachable through MANAGE_FORMS as well as one's own, so a row has to say
   * whose form it is - and it says it by NAME. Null for a personal form, and also for a form whose
   * association has since been deleted.
   */
  associationName?: string | null;
  /** Banner/header image URL (public, served via media-service). */
  imageUrl?: string | null;
}

import { apiFetch } from '$lib/utils/apiFetch';
import { getToken } from '$lib/stores/auth';
import { socialUrl } from '$lib/utils/apiUrl';
import { fetchUpload } from '$lib/media';
import type { XhrUploadOptions } from '$lib/utils/uploadXhr';
import { amountBoundsOf, SocialApiError } from '$lib/associations/api';
import { Log } from '$lib/utils/Log';
import { assertWithinRequestBudget } from '$lib/utils/mediaRequestLimits';

/**
 * A refused call, typed at the THROW: the status always, the server's stable `code` when the body
 * carried one. Read the status with `refusalStatus` and a code with `refusalCode`; never branch on
 * the message. The message is the server's own sentence, or `fallback` when it gave none - a save
 * refused for a reason the manager can fix (a public form with a price) keeps its reason, and the
 * validation pipe's LIST of sentences is joined. It is dev-facing: a screen words the refusal from
 * the status and code (`describeApiRefusal`), not from this.
 *
 * A body that is not JSON (the host WAF's HTML page, a proxy error) carries no code and no
 * sentence, so the fallback reads and the status stays the discriminator.
 */
async function refusal(res: Response, fallback: string): Promise<SocialApiError> {
  const body = await res.json().catch(() => ({}));
  const message = Array.isArray(body.message) ? body.message.join(' ') : body.message;
  const code = typeof body.code === 'string' ? body.code : null;
  Log.i('FORMS', `${fallback}: refused status=${res.status} code=${code ?? 'none'}`);
  return new SocialApiError(
    message || `${fallback} (${res.status})`,
    code,
    res.status,
    amountBoundsOf(body)
  );
}

export async function createForm(payload: CreateFormPayload): Promise<Form> {
  const res = await apiFetch(`${socialUrl()}/api/forms`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await refusal(res, 'Failed to create form');
  return res.json();
}

export async function getForms(): Promise<Form[]> {
  const url = `${socialUrl()}/api/forms`;
  const res = await apiFetch(url);
  if (!res.ok) throw await refusal(res, 'Failed to fetch forms');
  return res.json();
}

/**
 * The server ANSWERED 404: this form does not exist (a deleted one included). A type, not a
 * sentence, so a screen renders its own localized "form not found" state by `instanceof` instead of
 * printing whatever English the throw carried.
 */
export class FormNotFoundError extends Error {
  constructor(readonly formId: string) {
    super(`Form ${formId} not found`);
    this.name = 'FormNotFoundError';
  }
}

export async function getForm(id: string): Promise<Form> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${id}`);
  if (res.status === 404) throw new FormNotFoundError(id);
  if (!res.ok) throw await refusal(res, 'Failed to fetch form');
  const text = await res.text();
  if (!text) throw new Error('Empty response from server');
  return JSON.parse(text) as Form;
}

/** Updates a form's metadata and questions. Requires owner, co-owner, or MANAGE_FORMS flag. */
export async function updateForm(id: string, payload: CreateFormPayload): Promise<Form> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await refusal(res, 'Failed to update form');
  return res.json();
}

/** Uploads a banner image for a form. Returns the updated form with `imageUrl`. */
export async function uploadFormImage(id: string, file: File): Promise<Form> {
  const token = await getToken().catch(() => '');
  const fd = new FormData();
  fd.append('file', file);
  assertWithinRequestBudget(fd);
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${socialUrl()}/api/forms/${id}/image`, {
    method: 'POST',
    headers,
    body: fd,
  });
  if (!res.ok) throw await refusal(res, 'Upload failed');
  return (await res.json()) as Form;
}

/** Uploads a public image for use in a form question. Returns `{ imageUrl }`. */
export async function uploadFormItemImage(
  formId: string,
  file: File
): Promise<{ imageUrl: string }> {
  const token = await getToken().catch(() => '');
  const fd = new FormData();
  fd.append('file', file);
  assertWithinRequestBudget(fd);
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${socialUrl()}/api/forms/${formId}/items/image`, {
    method: 'POST',
    headers,
    body: fd,
  });
  if (!res.ok) throw await refusal(res, 'Upload failed');
  return res.json();
}

/** Deletes a form entirely. */
export async function deleteForm(id: string): Promise<{ ok: boolean }> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${id}`, { method: 'DELETE' });
  if (!res.ok) throw await refusal(res, 'Failed to delete form');
  return res.json();
}

/** Removes the banner image from a form. */
export async function deleteFormImage(id: string): Promise<Form> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${id}/image`, { method: 'DELETE' });
  if (!res.ok) throw await refusal(res, 'Failed to delete form image');
  return res.json();
}

export async function getSubmission(formId: string): Promise<any> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${formId}/submission`);
  if (!res.ok) throw await refusal(res, 'Failed to fetch submission');
  return res.json();
}

/** One group of a pricing criterion still to be resolved from the submitter's answers. */
export interface AnswerDimensionView {
  id: string;
  questionId: string;
  buckets: { id: string; label: string; values: string[] }[];
}

/**
 * The submitter's own slice of the pricing grid.
 *
 * The server has already resolved everything about WHO they are - cotisation, promo, formation -
 * because the page cannot know those and must not be trusted with them. What comes back is the row
 * that applies to them: the criteria still open (their own answers), and the price each combination
 * leads to. The page totals from this and never derives a rule of its own.
 */
export interface PricingView {
  /**
   * Price before any answer criterion is resolved. `null` when that combination is UNAVAILABLE -
   * the manager marked it as not existing, which is a refusal and not a price of zero. See
   * `CellValue` in `priceMatrix.ts`.
   */
  baseCents: number | null;
  /** The groups that already applied, for display: "Cotisant", "ICM". */
  appliedLabels: string[];
  answerDimensions: AnswerDimensionView[];
  /**
   * Price per combination of the answer groups, keyed by their ids joined with "|". Complete: every
   * combination is present, `null` for the ones that are unavailable.
   */
  cells: Record<string, number | null>;
  /** Questions whose option modifiers must NOT be added - their answer selects a cell instead. */
  ignoredModifierQuestionIds: string[];
}

export async function checkSubmission(formId: string): Promise<{
  hasSubmitted: boolean;
  paymentStatus?: string;
  /** The id of the caller's own answer when there is one (a `pending` one is confirmed on load). */
  submissionId?: string;
  formFull: boolean;
  /** Null when the form has one price for everybody. */
  pricing: PricingView | null;
  /** Questions hidden from this submitter by a profile criterion, answers aside. */
  hiddenItemIds: string[];
  /** False when a `submitCondition` excludes them. */
  maySubmit: boolean;
  /**
   * Why `submitCondition` excludes them, typed (`FORM_COTISATION_HELD`, `FORM_NOT_OPEN_TO_YOU`),
   * or null. Absent from a server older than it, which reads as null.
   */
  refusalCode?: string | null;
}> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${formId}/check`);
  if (!res.ok) throw await refusal(res, 'Failed to check submission status');
  return res.json();
}

/** A form submission enriched with the submitter's first/last name. */
export interface Submission {
  id: string;
  formId: string;
  /** Null on an anonymous form: the answer has no author by design. */
  userId: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  answers: Record<string, unknown>;
  totalPaid: number;
  paymentStatus: string;
  createdAt: string;
  /** The reference a PAYING GUEST was given ("1A2B-3C4D"); null on every other row. */
  reference?: string | null;
  /** The file answers of this submission whose file the retention purge has deleted. */
  deletedFileIds?: string[];
  /** The live files of this submission, by id: the name a manager's download is saved under. */
  fileNames?: Record<string, string>;
}

/** Returns all submissions for a form with submitter names (form manager only). */
export async function getSubmissions(formId: string): Promise<Submission[]> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${encodeURIComponent(formId)}/submissions`);
  if (!res.ok) throw await refusal(res, 'Failed to fetch submissions');
  return res.json();
}

/** The payment state of the caller's own submission, read by the return page after Lydia. */
export async function getSubmissionPayment(submissionId: string): Promise<{
  id: string;
  formId: string;
  paymentStatus: string;
  /** The request's state, typed, when the server read it on this call. */
  requestState?: PaymentRequestState;
}> {
  const res = await apiFetch(
    `${socialUrl()}/api/forms/submissions/${encodeURIComponent(submissionId)}`
  );
  if (!res.ok) throw await refusal(res, 'Failed to read the submission');
  return res.json();
}

/**
 * Asks the server to read, at the payment provider, whether a pending online answer was paid, and
 * to record it if so - then answers the submission like `getSubmissionPayment`. The payer's return
 * page calls it, so a payment whose provider callback was lost is still confirmed. A request the
 * payer declined, or that was cancelled or expired, releases the answer: `requestState` says which,
 * and the page offers the retry (`paymentReturnVerdict`).
 */
export async function confirmSubmissionPayment(submissionId: string): Promise<{
  id: string;
  formId: string;
  paymentStatus: string;
  /** The request's state, typed, when the server read it on this call. */
  requestState?: PaymentRequestState;
}> {
  const res = await apiFetch(
    `${socialUrl()}/api/forms/submissions/${encodeURIComponent(submissionId)}/confirm-payment`,
    { method: 'POST' }
  );
  if (!res.ok) throw await refusal(res, 'Failed to confirm the payment');
  return res.json();
}

/** Deletes a submission. Requires form manager access. */
export async function deleteSubmission(submissionId: string): Promise<void> {
  const res = await apiFetch(
    `${socialUrl()}/api/forms/submissions/${encodeURIComponent(submissionId)}`,
    {
      method: 'DELETE',
    }
  );
  if (!res.ok) throw await refusal(res, 'Failed to delete submission');
}

/**
 * THE WORDS AN EXPORT IS WRITTEN IN, AND WHY THEY TRAVEL WITH THE REQUEST.
 *
 * The xlsx is assembled by `social-service`, and a service has no Paraglide, no locale and no way to
 * acquire either - so until 2026-09-22 it wrote `Timestamp`, `First name`, `Amount paid` and the raw
 * `free` enum into a file a French user opens. Giving the server a table of its own would put
 * user-visible strings somewhere no translator looks, which this repository forbids everywhere else.
 *
 * So the discriminator is carried from where it is already KNOWN: the client is the only thing that
 * has both the locale and the message catalogue, and it sends the words. The server then has no
 * string of its own to get wrong. `ExportLabels` is mirrored by `forms.service.ts` - the same
 * hand-kept pairing `answer-text.ts` already has with `answerText.ts` - and a request without it is
 * refused rather than defaulted, because there is no language to default TO.
 *
 * The form's OWN questions are not in here: their labels were written by whoever built the form, in
 * whatever language they chose, and the server already has them.
 */
export interface ExportLabels {
  date: string;
  firstName: string;
  lastName: string;
  amount: string;
  status: string;
  /** Every payment status this client knows, by its stored value. */
  statuses: Record<string, string>;
  /** What a FILE question's cell reads: the file is never exported, only this word. */
  file: string;
  /** The same cell once the retention purge has deleted the file. */
  fileDeleted: string;
}

/** The labels this client would write an export in, resolved through Paraglide. */
export function exportLabels(): ExportLabels {
  return {
    date: m.form_list_col_date(),
    firstName: m.form_export_col_first_name(),
    lastName: m.form_export_col_last_name(),
    amount: m.form_list_col_amount(),
    status: m.form_list_col_status(),
    statuses: statusLabels(),
    file: m.form_answer_file(),
    fileDeleted: m.form_answer_file_deleted(),
  };
}

/**
 * The words a FILE answer reads as on this screen, for `answerText`. `deletedFiles` comes from the
 * submissions the server returned (`deletedFileIds`).
 */
export function fileAnswerWords(submissions: Pick<Submission, 'deletedFileIds'>[]): AnswerWords {
  return {
    file: m.form_answer_file(),
    fileDeleted: m.form_answer_file_deleted(),
    deletedFiles: new Set(submissions.flatMap((s) => s.deletedFileIds ?? [])),
  };
}

/** What an answer file's upload returns: the id the answer carries, and what the page shows. */
export interface UploadedAnswerFile {
  fileId: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
}

/**
 * Uploads the file of one FILE question before the answer is sent. The answer then carries
 * `fileId`; the server accepts it only from the member who uploaded it, for this question.
 *
 * Through `fetchUpload` (an XHR), never `fetch`: it is the one transport that reports how much has
 * left and can be cancelled, which an 8 MiB file on a weak link needs. `transport.signal` cancels
 * (rejecting with `UploadAbortedError`), `transport.onProgress` reports the bytes sent.
 */
export async function uploadFormAnswerFile(
  formId: string,
  itemId: string,
  file: File,
  transport: XhrUploadOptions = {}
): Promise<UploadedAnswerFile> {
  const fd = new FormData();
  fd.append('itemId', itemId);
  fd.append('file', file);
  const res = await fetchUpload(
    `${socialUrl()}/api/forms/${encodeURIComponent(formId)}/files`,
    (token) => ({ method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd }),
    await getToken(),
    transport
  );
  if (!res.ok) throw await refusal(res, 'File upload failed');
  return res.json();
}

/** A manager's download of one answer's file - the only way it is ever read. */
export async function downloadFormAnswerFile(formId: string, fileId: string): Promise<Blob> {
  const res = await apiFetch(
    `${socialUrl()}/api/forms/${encodeURIComponent(formId)}/files/${encodeURIComponent(fileId)}`
  );
  if (!res.ok) throw await refusal(res, 'File download failed');
  return res.blob();
}

export async function exportSubmissions(id: string, labels: ExportLabels): Promise<Blob> {
  const query = encodeURIComponent(JSON.stringify(labels));
  const res = await apiFetch(`${socialUrl()}/api/forms/${id}/export?labels=${query}`);
  if (!res.ok) throw await refusal(res, 'Failed to export submissions');
  return res.blob();
}
/** A submission awaiting cash payment validation. */
export interface PendingCashSubmission {
  id: string;
  formId: string;
  userId: string;
  email: string | null;
  answers: Record<string, unknown>;
  totalPaid: number;
  paymentStatus: string;
  createdAt: string;
}

/** Lists submissions awaiting cash validation for a form (requires form owner or MANAGE_FORMS). */
export async function listPendingCashSubmissions(formId: string): Promise<PendingCashSubmission[]> {
  const res = await apiFetch(
    `${socialUrl()}/api/forms/${encodeURIComponent(formId)}/submissions/pending-cash`
  );
  if (!res.ok) throw await refusal(res, 'Failed to fetch pending cash submissions');
  return res.json();
}

/** Validates a cash payment for a submission (requires form owner or MANAGE_FORMS). */
export async function validateCashSubmission(
  formId: string,
  submissionId: string
): Promise<{ ok: boolean }> {
  const res = await apiFetch(
    `${socialUrl()}/api/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(submissionId)}/validate-cash`,
    { method: 'POST' }
  );
  if (!res.ok) throw await refusal(res, 'Validation failed');
  return res.json();
}

/** Cancels a pending cash submission (requires form owner or MANAGE_FORMS). */
export async function cancelCashSubmission(
  formId: string,
  submissionId: string
): Promise<{ ok: boolean }> {
  const res = await apiFetch(
    `${socialUrl()}/api/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(submissionId)}/cancel-cash`,
    { method: 'POST' }
  );
  if (!res.ok) throw await refusal(res, 'Cancellation failed');
  return res.json();
}

/** Cancels a pending online-payment submission after payment failure or user abort. */
export async function cancelPendingSubmission(
  submissionId: string
): Promise<{ ok: boolean; alreadyPaid?: boolean }> {
  const res = await apiFetch(
    `${socialUrl()}/api/forms/submissions/${encodeURIComponent(submissionId)}/cancel`,
    { method: 'POST' }
  );
  if (!res.ok) throw await refusal(res, 'Cancellation failed');
  return res.json();
}

export async function submitForm(
  id: string,
  payload: {
    email?: string;
    /** Where the payment request goes when Lydia is the provider. Never stored by Canari. */
    payerEmail?: string;
    answers: any;
    successUrl?: string;
    cancelUrl?: string;
    paymentMethod?: 'online' | 'cash';
  }
): Promise<any> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${id}/submit`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  // Through the one builder, so a payment refusal (`code`, and the amount bounds) is worded by
  // `providerRefusalMessage` in the reader's language rather than shown as the server's prose.
  if (!res.ok) throw await refusal(res, 'Submission failed');
  return res.json();
}

/**
 * What a guest on a public form's link is served: the questions, what they cost, and nothing about
 * its owner. A public form may charge (WP-P1): a base price, option supplements, cash, and a grid on
 * ANSWERS, whose whole slice is `pricing` (a guest has no profile for a grid to resolve).
 */
export type PublicForm = Pick<
  Form,
  | 'id'
  | 'title'
  | 'description'
  | 'imageUrl'
  | 'items'
  | 'opensAt'
  | 'anonymous'
  | 'basePrice'
  | 'currency'
  | 'allowCashPayment'
> & {
  closedAt?: string | null;
  formFull: boolean;
  pricing: PricingView | null;
};

/**
 * What a guest's submit answers: that it was taken, and when the form charges, Lydia's payer page
 * to go to or that cash is owed to the organiser. Never a submission id.
 */
export interface PublicSubmitReply {
  ok: true;
  checkoutUrl?: string;
  cashPayment?: true;
  /** With `cashPayment`: the reference the guest gives the organiser. */
  reference?: string;
}

/**
 * What the guest return page reads about a paid answer, for whoever holds its receipt (WP-P2): the
 * reference to give the organiser, the amount, and where the payment stands. Never an id.
 */
export interface GuestReceipt {
  reference: string;
  formId: string;
  totalPaid: number;
  currency: string;
  paymentStatus: string;
  /** The provider state the server read on THIS call; absent when none was. */
  requestState?: PaymentRequestState;
}

/**
 * Confirms a guest's payment from its RECEIPT - the proof Lydia's return URL carries instead of a
 * session. The server reads the answer's own request at Lydia; nothing else from the URL is sent.
 * The receipt goes in the body, so it stays out of access logs. Plain `fetch`: a guest has no
 * session. A refusal is a `SocialApiError` (404: no answer has this receipt; 429: the per-receipt
 * limit on asking Lydia).
 */
export async function confirmGuestReceipt(receipt: string): Promise<GuestReceipt> {
  const res = await fetch(`${socialUrl()}/api/public/forms/receipts/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ receipt }),
  });
  if (!res.ok) throw await refusal(res, 'Receipt could not be read');
  return res.json();
}

/** Why a public form could not be read: it is not there (or not public), or the call failed. */
export class PublicFormUnavailableError extends Error {
  constructor(readonly notFound: boolean) {
    super(notFound ? 'Public form not found' : 'Public form could not be loaded');
    this.name = 'PublicFormUnavailableError';
  }
}

/**
 * Reads a public form WITHOUT a session - plain `fetch`, never `apiFetch`, whose refresh-and-retry
 * is for a signed-in caller and would send a guest's browser to a token endpoint for nothing.
 */
export async function getPublicForm(id: string): Promise<PublicForm> {
  const res = await fetch(`${socialUrl()}/api/public/forms/${encodeURIComponent(id)}`);
  if (!res.ok) throw new PublicFormUnavailableError(res.status === 404 || res.status === 400);
  return res.json();
}

/**
 * Sends one guest answer. `website` is the honeypot the page hides from people; the server drops
 * any answer that fills it. A paid answer carries the address Lydia sends the request to
 * (`payerEmail`, never stored) and the method. A refusal is thrown through the one builder, so a
 * payment refusal (`code`, the amount bounds) is worded by `providerRefusalMessage`.
 */
export async function submitPublicForm(
  id: string,
  payload: {
    answers: Record<string, unknown>;
    website: string;
    payerEmail?: string;
    paymentMethod?: 'online' | 'cash';
  }
): Promise<PublicSubmitReply> {
  const res = await fetch(`${socialUrl()}/api/public/forms/${encodeURIComponent(id)}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await refusal(res, 'Submission failed');
  return res.json();
}
