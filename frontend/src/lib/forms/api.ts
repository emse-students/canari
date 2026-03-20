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
  ownerId: string;
}

export interface Form extends CreateFormPayload {
  _id: string;
  createdAt: string;
  updatedAt: string;
}

const API_Base = import.meta.env.VITE_FORM_SERVICE_URL || 'http://localhost:3008/api';

export async function createForm(payload: CreateFormPayload): Promise<Form> {
  const res = await fetch(`${API_Base}/forms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to create form');
  return res.json();
}

export async function getForms(ownerId?: string): Promise<Form[]> {
  const url = ownerId ? `${API_Base}/forms?ownerId=${ownerId}` : `${API_Base}/forms`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch forms');
  return res.json();
}

export async function getForm(id: string): Promise<Form> {
  const res = await fetch(`${API_Base}/forms/${id}`);
  if (!res.ok) throw new Error('Failed to fetch form');
  return res.json();
}

export async function checkSubmission(
  formId: string,
  userId: string
): Promise<{ hasSubmitted: boolean }> {
  const res = await fetch(`${API_Base}/forms/${formId}/check?userId=${userId}`);
  if (!res.ok) throw new Error('Failed to check submission status');
  return res.json();
}

export async function exportSubmissions(id: string): Promise<Blob> {
  const res = await fetch(`${API_Base}/forms/${id}/export`);
  if (!res.ok) throw new Error('Failed to export submissions');
  return res.blob();
}
export async function submitForm(id: string, payload: any): Promise<any> {
  const res = await fetch(`${API_Base}/forms/${id}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Submission failed');
  }
  return res.json();
}
