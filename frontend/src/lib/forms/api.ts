export interface FormOption {
  label: string;
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
  /** Option label that must be selected in the dependsOn question to show this one. */
  dependsValue?: string;
}

export interface CreateFormPayload {
  title: string;
  description?: string;
  basePrice: number;
  currency: string;
  submitLabel: string;
  items: FormItem[];
  maxSubmissions?: number;
  /** ISO 8601 - submissions blocked until this instant. */
  opensAt?: string;
  requiresPayment?: boolean;
  associationId?: string;
  paymentMethods?: string[];
  /** Allow the same user to submit multiple times (e.g. product orders). */
  allowMultipleSubmissions?: boolean;
  /** Whether cash (physical) payment is accepted as an alternative to Stripe. */
  allowCashPayment?: boolean;
  /** Days after submission before an unvalidated cash payment expires (null = never). */
  cashPaymentExpiryDays?: number;
  /** Tag name automatically granted upon successful payment (e.g. "cotisant:bde-2026"). */
  grantedTagName?: string;
  /** ISO 8601 - when the granted tag expires (omit for permanent). */
  tagExpiresAt?: string;
}

export interface Form extends CreateFormPayload {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Banner/header image URL (public, served via media-service). */
  imageUrl?: string | null;
  /** Additional user IDs that can manage this form and view submissions. */
  coOwners?: string[];
}

import { apiFetch } from '$lib/utils/apiFetch';
import { getToken } from '$lib/stores/auth';
import { socialUrl } from '$lib/utils/apiUrl';

export async function createForm(payload: CreateFormPayload): Promise<Form> {
  const res = await apiFetch(`${socialUrl()}/api/forms`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to create form');
  return res.json();
}

export async function getForms(): Promise<Form[]> {
  const url = `${socialUrl()}/api/forms`;
  const res = await apiFetch(url);
  if (!res.ok) throw new Error('Failed to fetch forms');
  return res.json();
}

export async function getForm(id: string): Promise<Form> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${id}`);
  if (!res.ok) throw new Error('Failed to fetch form');
  return res.json();
}

/** Updates a form's metadata and questions. Requires owner, co-owner, or MANAGE_FORMS flag. */
export async function updateForm(id: string, payload: CreateFormPayload): Promise<Form> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to update form');
  return res.json();
}

/** Uploads a banner image for a form. Returns the updated form with `imageUrl`. */
export async function uploadFormImage(id: string, file: File): Promise<Form> {
  const token = await getToken().catch(() => '');
  const fd = new FormData();
  fd.append('file', file);
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${socialUrl()}/api/forms/${id}/image`, {
    method: 'POST',
    headers,
    body: fd,
  });
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`upload ${res.status}: ${details || res.statusText}`);
  }
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
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${socialUrl()}/api/forms/${formId}/items/image`, {
    method: 'POST',
    headers,
    body: fd,
  });
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`upload ${res.status}: ${details || res.statusText}`);
  }
  return res.json();
}

/** Deletes a form entirely. */
export async function deleteForm(id: string): Promise<{ ok: boolean }> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete form');
  return res.json();
}

/** Removes the banner image from a form. */
export async function deleteFormImage(id: string): Promise<Form> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${id}/image`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete form image');
  return res.json();
}

/** Adds a co-owner to a form (owner/global-admin only). */
export async function addFormCoOwner(formId: string, userId: string): Promise<{ ok: boolean }> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${formId}/co-owners`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) throw new Error('Failed to add co-owner');
  return res.json();
}

/** Removes a co-owner from a form (owner/global-admin only). */
export async function removeFormCoOwner(formId: string, userId: string): Promise<{ ok: boolean }> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${formId}/co-owners/${userId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to remove co-owner');
  return res.json();
}

export async function getSubmission(formId: string): Promise<any> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${formId}/submission`);
  if (!res.ok) throw new Error('Failed to fetch submission');
  return res.json();
}

export async function checkSubmission(
  formId: string
): Promise<{ hasSubmitted: boolean; paymentStatus?: string }> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${formId}/check`);
  if (!res.ok) throw new Error('Failed to check submission status');
  return res.json();
}

/** A form submission enriched with the submitter's first/last name. */
export interface Submission {
  id: string;
  formId: string;
  userId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  answers: Record<string, unknown>;
  totalPaid: number;
  paymentStatus: string;
  createdAt: string;
}

/** Returns all submissions for a form with submitter names (form manager only). */
export async function getSubmissions(formId: string): Promise<Submission[]> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${encodeURIComponent(formId)}/submissions`);
  if (!res.ok) throw new Error('Failed to fetch submissions');
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
  if (!res.ok) throw new Error('Failed to delete submission');
}

export async function exportSubmissions(id: string): Promise<Blob> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${id}/export`);
  if (!res.ok) throw new Error('Failed to export submissions');
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
  if (!res.ok) throw new Error('Failed to fetch pending cash submissions');
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
  if (!res.ok) throw new Error('Validation failed');
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
  if (!res.ok) throw new Error('Cancellation failed');
  return res.json();
}

export async function submitForm(
  id: string,
  payload: {
    email?: string;
    answers: any;
    successUrl?: string;
    cancelUrl?: string;
    paymentMethod?: 'stripe' | 'cash';
  }
): Promise<any> {
  const res = await apiFetch(`${socialUrl()}/api/forms/${id}/submit`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Submission failed');
  }
  return res.json();
}
