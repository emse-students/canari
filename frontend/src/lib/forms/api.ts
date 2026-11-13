import { m } from '$lib/paraglide/messages';
import { statusLabels } from './paymentStatus';
import type { AnswerWords } from './answerText';
import type { PaymentRequestState } from './paymentReturn';
import type { ProductGridLine, ProductGridPrices, ProductGridView } from './productGridContract';
import type { GuestIdentityField } from './guestIdentity';

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
  /**
   * A REQUIRED grid wants every row answered only when this is on; otherwise one answered row is
   * enough (decided 2026-11-06, D5). Read only for `matrix_single` / `matrix_multiple`.
   */
  requireEveryRow?: boolean;
  scale?: {
    min: number;
    max: number;
    minLabel?: string;
    maxLabel?: string;
  };
  /** Optional image shown under the label and help: `/api/media/public/<id>`, from `uploadFormItemImage`. */
  imageUrl?: string;
  /** The image's text alternative; absent: `questionImageAlt` names the question. */
  imageAlt?: string;
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
  /**
   * A `product_grid` question's definition: its rows, columns, cap per cell, closed cells and price
   * MODE - what every reader may rely on. A manager's read also carries the price lists
   * (`ProductGrid`); a fill page never reads them from here - the viewer's own prices come resolved
   * as `productGridPrices` (`productGridContract.ts`).
   */
  productGrid?: ProductGridView;
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
  /**
   * The association the form belongs to. A create names it or nothing; an edit leaves it when
   * absent, and `''` names none. Only a DRAFT may change it - a published form's is fixed
   * (`FORM_ASSOCIATION_FIXED`, docs/wiki/frontend/modules/forms.md).
   */
  associationId?: string;
  paymentMethods?: string[];
  /** Allow the same user to submit multiple times (e.g. product orders). */
  allowMultipleSubmissions?: boolean;
  /**
   * A respondent with an account may change their own answer while the form is open, the questions
   * that touch the price excepted (migration 166). Refused beside `anonymous`.
   */
  allowAnswerEdit?: boolean;
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
  /**
   * What a public form asks a guest about who they are (`guestIdentity.ts`): any of `lastName`,
   * `firstName`, `email`, each required once asked. Null or absent asks nothing, the default.
   */
  guestFields?: GuestIdentityField[] | null;
  /** Whether cash (physical) payment is accepted as an alternative to the online payment. */
  allowCashPayment?: boolean;
  /**
   * Whether online payment is accepted (owner, 2026-11-08); absent keeps the stored value, true for
   * a new form. Off with cash on is a cash-only form.
   */
  allowOnlinePayment?: boolean;
  /**
   * True when the form charges and its organiser cannot collect right now - a list whose delegation
   * was revoked, or whose receiver lost its Lydia (owner, 2026-11-02). DERIVED by the server on every
   * read, never stored: it resumes by itself on a new accepted delegation.
   */
  paymentsPaused?: boolean;
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
  /**
   * CREATE ONLY: `true` stores the form as a DRAFT, seen by its managers alone until
   * {@link publishFormDraft}. The server refuses it on an edit.
   */
  draft?: boolean;
  /**
   * CREATE ONLY: the create's idempotency key, minted here so that a create whose answer was lost is
   * sent again as the same create (the server answers the form it stored). Never the form's id: the
   * server mints that. Refused on an edit.
   */
  clientCreateId?: string;
}

/** A form's life (`form-status.ts` on the server): `draft` until published, then for good. */
export type FormStatus = 'draft' | 'published';

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
  /** Answers holding a place (`GET /forms/:id` only): the editor warns before removing an ordered row. */
  submissionCount?: number;
  /** `draft` until a manager publishes it; absent on a server before drafts, which is `published`. */
  status?: FormStatus;
  /**
   * Whether an unpublished revision holds edits (the managers' list only, migration 146): the row
   * says so, and its "Voir le formulaire" opens the preview of those edits.
   */
  hasUnpublishedChanges?: boolean;
}

/**
 * The unpublished revision of a form (owner, 2026-11-08): the editor's whole payload as last saved,
 * and its compare-and-set number. Revision 0 and no document: nothing was ever saved.
 */
export interface FormDraft {
  revision: number;
  document: CreateFormPayload | null;
  savedAt: string | null;
  /** The client id of the save that wrote this revision: a device copy naming it has landed. */
  saveId?: string | null;
  /**
   * The last save ids that wrote the revision, kept across a publication or a discard: a device copy
   * whose own save is among them landed, whatever another writer built on it since.
   */
  recentSaveIds?: string[];
}

import { apiFetch } from '$lib/utils/apiFetch';
import { getToken } from '$lib/stores/auth';
import { socialUrl } from '$lib/utils/apiUrl';
import { fetchUpload } from '$lib/media';
import type { XhrUploadOptions } from '$lib/utils/uploadXhr';
import { amountBoundsOf, SocialApiError } from '$lib/associations/api';
import { Log } from '$lib/utils/Log';
import { assertWithinRequestBudget } from '$lib/utils/mediaRequestLimits';
import { prepareQuestionImage } from './questionImage';
import { FORM_DRAFT_CONFLICT, FormDraftConflictError } from './draftConflict';

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
  const itemId = typeof body.itemId === 'string' ? body.itemId : null;
  Log.i(
    'FORMS',
    `${fallback}: refused status=${res.status} code=${code ?? 'none'} item=${itemId ?? 'none'}`
  );
  return new SocialApiError(
    message || `${fallback} (${res.status})`,
    code,
    res.status,
    amountBoundsOf(body),
    null,
    itemId
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

/** Reads the unpublished revision of a form (managers only). */
export async function getFormDraft(id: string): Promise<FormDraft> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${id}/draft`);
  if (!res.ok) throw await refusal(res, 'Failed to read the form revision');
  return res.json();
}

/**
 * The largest body sent with `keepalive` (the page is being left): engines cap the bodies of all
 * keepalive requests in flight at 64 KiB together. A larger revision is not lost - the device copy
 * holds it until the next send (`draftCopies.ts`).
 */
export const KEEPALIVE_BODY_MAX = 60_000;

/**
 * The autosave: stores `document` as the revision after `baseRevision`, under the client's `saveId`.
 * Refused {@link FormDraftConflictError} when another tab, a publication or a discard moved it first;
 * a transport failure throws what `fetch` threw (no status: nobody answered). `leaving`: the page is
 * being hidden or left, so the request is asked to outlive it (`keepalive`) when its body fits.
 */
export async function saveFormDraft(
  id: string,
  baseRevision: number,
  document: CreateFormPayload,
  saveId: string,
  opts: { leaving?: boolean } = {}
): Promise<{ revision: number; savedAt: string }> {
  const body = JSON.stringify({ baseRevision, document, saveId });
  const keepalive = opts.leaving === true && body.length <= KEEPALIVE_BODY_MAX;
  if (opts.leaving && !keepalive) {
    Log.d(
      'FORMS',
      `revision of ${id} too large to outlive the page (${body.length}); the device copy holds it`
    );
  }
  const res = await apiFetch(`${socialUrl()}/api/forms/${id}/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
    ...(keepalive ? { keepalive } : {}),
  });
  if (res.status === 409) {
    const answer = await res.json().catch(() => ({}));
    if (answer.code === FORM_DRAFT_CONFLICT && typeof answer.revision === 'number') {
      Log.i('FORMS', `revision save of ${id} refused: it is at ${answer.revision}`);
      throw new FormDraftConflictError(
        answer.revision,
        typeof answer.saveId === 'string' ? answer.saveId : null,
        Array.isArray(answer.recentSaveIds)
          ? answer.recentSaveIds.filter((id: unknown): id is string => typeof id === 'string')
          : []
      );
    }
    Log.i('FORMS', `revision save of ${id}: refused status=409 code=${answer.code ?? 'none'}`);
    throw new SocialApiError(
      `Failed to save the form revision (409)`,
      typeof answer.code === 'string' ? answer.code : null,
      409
    );
  }
  if (!res.ok) throw await refusal(res, 'Failed to save the form revision');
  return res.json();
}

/**
 * "Publier les modifications" (and "Publier" for a draft form): applies revision `revision` with the
 * edit's own rules, in one transaction. The edit route's refusals come back unchanged.
 */
export async function publishFormDraft(
  id: string,
  revision: number,
  overwrite = false
): Promise<{ id: string; status: FormStatus; revision: number }> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${id}/draft/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(overwrite ? { revision, overwrite } : { revision }),
  });
  if (!res.ok) throw await refusal(res, 'Failed to publish the form changes');
  return res.json();
}

/** "Abandonner les modifications": empties revision `revision`; the form stays as published. */
export async function discardFormDraft(
  id: string,
  revision: number
): Promise<{ revision: number }> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${id}/draft/discard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision }),
  });
  if (!res.ok) throw await refusal(res, 'Failed to discard the form changes');
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

/**
 * Uploads the image of a form question, resized with the post preset first
 * (`prepareQuestionImage`). `formId` null: the form is not created yet (the create page) - the
 * server records the image as the caller's, and the form's first save binds it. Returns
 * `{ imageUrl }`, the one value the question may store.
 */
export async function uploadFormItemImage(
  formId: string | null,
  file: File
): Promise<{ imageUrl: string }> {
  const prepared = await prepareQuestionImage(file);
  const token = await getToken().catch(() => '');
  const fd = new FormData();
  fd.append('file', prepared);
  assertWithinRequestBudget(fd);
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const route = formId === null ? 'items/image' : `${formId}/items/image`;
  const res = await fetch(`${socialUrl()}/api/forms/${route}`, {
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
  /**
   * Question id -> this member's prices on that priced grid, the category resolved by the server.
   * Absent from a server older than the priced grid, which holds none.
   */
  productGridPrices?: ProductGridPrices;
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
  /** How the answer pays - online (Lydia) or cash; null on a free answer. */
  paymentMethod?: 'online' | 'cash' | null;
  /** What each ordered cell of a priced grid was CHARGED (migration 137); null without a grid. */
  lines?: ProductGridLine[] | null;
  createdAt: string;
  /** When the respondent last changed the answer (migration 166); null if never. */
  editedAt?: string | null;
  /** The reference a PAYING GUEST was given ("1A2B-3C4D"); null on every other row. */
  reference?: string | null;
  /** What a guest typed when the public form asked for it (migration 138); null otherwise. */
  guestLastName?: string | null;
  guestFirstName?: string | null;
  guestEmail?: string | null;
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
  /** Header of a guest's e-mail column, written when the form asks guests for it. */
  email: string;
  /** Header of the guest marker column (each guest row's reference), written when a row has no account. */
  guest: string;
  /** Header of the "last changed" column, written on a form that allows changes or holds a changed answer. */
  edited: string;
  /**
   * The words of a priced grid's "Articles" and "Totaux" sheets (`product-grid-export.ts`). Sent
   * with every export: the server refuses a grid form's export without them
   * (`EXPORT_LABELS_PRODUCT_GRID_MISSING`), and checks them, unused, on any other form.
   */
  productGrid: ProductGridExportLabels;
}

/** The words of the priced grid's two sheets, mirrored by `export-labels.ts`. */
export interface ProductGridExportLabels {
  articlesSheet: string;
  totalsSheet: string;
  buyer: string;
  guest: string;
  question: string;
  row: string;
  column: string;
  category: string;
  othersCategory: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  total: string;
  amount: string;
  received: string;
  awaitingCash: string;
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
    email: m.form_guest_identity_email(),
    guest: m.form_submitter_guest(),
    edited: m.form_export_col_edited(),
    productGrid: {
      articlesSheet: m.form_export_grid_articles_sheet(),
      totalsSheet: m.form_export_grid_totals_sheet(),
      buyer: m.form_export_grid_buyer(),
      guest: m.form_submitter_guest(),
      question: m.form_export_grid_question(),
      row: m.form_export_grid_row(),
      column: m.form_export_grid_column(),
      category: m.form_export_grid_category(),
      othersCategory: m.form_export_grid_others_category(),
      quantity: m.form_export_grid_quantity(),
      unitPrice: m.form_export_grid_unit_price(),
      lineTotal: m.form_export_grid_line_total(),
      total: m.form_export_grid_total(),
      amount: m.form_export_grid_amount(),
      received: m.form_export_grid_received(),
      awaitingCash: m.form_export_grid_awaiting_cash(),
    },
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

/**
 * What an export writes: the workbook (one row per answer, and a priced grid's "Articles" and
 * "Totaux" sheets), or ONE of those two grid sheets as CSV. Mirrors `SUBMISSIONS_EXPORT_FORMATS`.
 */
export type SubmissionsExportFormat = 'xlsx' | 'articles-csv' | 'totals-csv';

/** Downloads a form's answers in `format`; a CSV format is refused on a form without a grid. */
export async function exportSubmissions(
  id: string,
  labels: ExportLabels,
  format: SubmissionsExportFormat = 'xlsx'
): Promise<Blob> {
  const query = encodeURIComponent(JSON.stringify(labels));
  const res = await apiFetch(
    `${socialUrl()}/api/forms/${id}/export?labels=${query}&format=${format}`
  );
  if (!res.ok) throw await refusal(res, 'Failed to export submissions');
  return res.blob();
}
/** A submission awaiting cash payment validation. */
export interface PendingCashSubmission {
  id: string;
  formId: string;
  /** Null on a GUEST's answer, from a public form's link: there is no account to name. */
  userId: string | null;
  email: string | null;
  /** The reference a paying guest was given; null on a member's row. */
  reference?: string | null;
  /** What a guest typed when the public form asked for it (migration 138); null otherwise. */
  guestLastName?: string | null;
  guestFirstName?: string | null;
  guestEmail?: string | null;
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

/** One of the caller's own answers they may still change, as `GET :id/my-answers` serves it. */
export interface EditableAnswer {
  id: string;
  formId: string;
  answers: Record<string, unknown>;
  totalPaid: number;
  paymentStatus: string;
  createdAt: string;
  editedAt?: string | null;
  /** The questions that touch the price: drawn read-only, never sent changed. */
  lockedItemIds: string[];
}

/**
 * The caller's answers to this form they may still change - empty when the form does not allow it,
 * is anonymous or is closed. Newest first; one on a single-answer form.
 */
export async function getMyEditableAnswers(formId: string): Promise<EditableAnswer[]> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${encodeURIComponent(formId)}/my-answers`);
  if (!res.ok) throw await refusal(res, 'Failed to fetch your answers');
  return res.json();
}

/**
 * Changes the caller's own answer in place. Refusals carry a `code` (`FORM_ANSWER_LOCKED`, ...),
 * worded by `formSubmitRefusalMessage`; nothing about payment is sent or changed.
 */
export async function editFormAnswer(
  formId: string,
  submissionId: string,
  answers: Record<string, unknown>
): Promise<{ submissionId: string; editedAt: string | null }> {
  const res = await apiFetch(
    `${socialUrl()}/api/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(submissionId)}/answers`,
    { method: 'PUT', body: JSON.stringify({ answers }) }
  );
  if (!res.ok) throw await refusal(res, 'Answer change failed');
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
  | 'paymentsPaused'
> & {
  closedAt?: string | null;
  /** What the page asks a guest about who they are; [] asks nothing (`guestIdentity.ts`). */
  guestFields: GuestIdentityField[];
  formFull: boolean;
  pricing: PricingView | null;
  /** Question id -> a guest's prices on that priced grid ("everyone else", or the one list). */
  productGridPrices?: ProductGridPrices;
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
 * (`payerEmail`, never stored) and the method - or, when the form asks the guest's e-mail, that
 * e-mail (`guestEmail`, stored with the answer) is the address, typed once. A refusal is thrown through the one builder, so a
 * payment refusal (`code`, the amount bounds) is worded by `providerRefusalMessage`.
 */
export async function submitPublicForm(
  id: string,
  payload: {
    answers: Record<string, unknown>;
    website: string;
    payerEmail?: string;
    paymentMethod?: 'online' | 'cash';
    /** Only the fields the form asks (`guestIdentityPayload`); the server refuses any other. */
    guestLastName?: string;
    guestFirstName?: string;
    guestEmail?: string;
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
