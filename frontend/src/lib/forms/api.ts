export interface FormOption {
  label: string;
  priceModifier: number;
  id?: string;
}

export interface FormItem {
  id: string;
  label: string;
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
}

export interface CreateFormPayload {
  title: string;
  description?: string;
  basePrice: number;
  currency: string;
  submitLabel: string;
  items: FormItem[];
  maxSubmissions?: number;
  /** ISO 8601 — submissions blocked until this instant. */
  opensAt?: string;
  requiresPayment?: boolean;
  associationId?: string;
  paymentMethods?: string[];
}

export interface Form extends CreateFormPayload {
  id: string;
  createdAt: string;
  updatedAt: string;
}

import { apiFetch } from '$lib/utils/apiFetch';

const API_Base = import.meta.env.VITE_SOCIAL_URL || '';

async function request(url: string, init: RequestInit = {}) {
  return apiFetch(url, init as any);
}

export async function createForm(payload: CreateFormPayload): Promise<Form> {
  const res = await request(`${API_Base}/api/forms`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to create form');
  return res.json();
}

export async function getForms(): Promise<Form[]> {
  const url = `${API_Base}/api/forms`;
  const res = await request(url);
  if (!res.ok) throw new Error('Failed to fetch forms');
  return res.json();
}

export async function getForm(id: string): Promise<Form> {
  const res = await request(`${API_Base}/api/forms/${id}`);
  if (!res.ok) throw new Error('Failed to fetch form');
  return res.json();
}

export async function getSubmission(formId: string): Promise<any> {
  const res = await request(`${API_Base}/api/forms/${formId}/submission`);
  if (!res.ok) throw new Error('Failed to fetch submission');
  return res.json();
}

export async function checkSubmission(formId: string): Promise<{ hasSubmitted: boolean }> {
  const res = await request(`${API_Base}/api/forms/${formId}/check`);
  if (!res.ok) throw new Error('Failed to check submission status');
  return res.json();
}

export async function exportSubmissions(id: string): Promise<Blob> {
  const res = await request(`${API_Base}/api/forms/${id}/export`);
  if (!res.ok) throw new Error('Failed to export submissions');
  return res.blob();
}
export async function submitForm(
  id: string,
  payload: {
    email?: string;
    answers: any;
    successUrl?: string;
    cancelUrl?: string;
  }
): Promise<any> {
  const res = await request(`${API_Base}/api/forms/${id}/submit`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Submission failed');
  }
  return res.json();
}
