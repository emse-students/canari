import { apiFetch } from '$lib/utils/apiFetch';
import { getToken } from '$lib/stores/auth';

export interface AssociationMember {
  id: string;
  associationId: string;
  userId: string;
  displayName: string | null;
  role: string;
  permission: 0 | 1;
  createdAt: string;
}

export interface Association {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  bioMarkdown: string | null;
  logoUrl: string | null;
  stripeAccountId: string | null;
  stripeOnboardingComplete: boolean;
  createdBy: string;
  memberCount?: number;
  role?: string;
  /** 0 = member, 1 = admin (when returned from `/api/associations/me/list`). */
  permission?: 0 | 1;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAssociationPayload {
  name: string;
  slug: string;
  description?: string;
  bioMarkdown?: string;
  logoUrl?: string;
}

export interface UpdateAssociationPayload {
  name?: string;
  description?: string;
  bioMarkdown?: string;
  logoUrl?: string;
}

/** Resolve association logo URL for `<img src>` (handles relative `/api/...` paths). */
export function associationLogoSrc(logoUrl: string | null | undefined): string | null {
  if (!logoUrl?.trim()) return null;
  const u = logoUrl.trim();
  if (u.startsWith('/')) {
    if (typeof window !== 'undefined') return `${window.location.origin}${u}`;
    return u;
  }
  return u;
}

function socialUrl(): string {
  const env = typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SOCIAL_URL;
  if (typeof env === 'string' && env.trim()) return env.trim().replace(/\/$/, '');
  return '';
}

function coreUrl(): string {
  const url =
    typeof import.meta !== 'undefined'
      ? ((import.meta as any).env?.VITE_CORE_URL as string | undefined)
      : undefined;
  if (url?.trim()) return url.trim();
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3012';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = socialUrl();
  const res = await apiFetch(`${base}${path}`, init as any);
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`associations ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as T;
}

// ── Public ────────────────────────────────────────────────────────────────

export async function listAssociations(): Promise<Association[]> {
  return request<Association[]>('/api/associations');
}

export async function getAssociation(id: string): Promise<Association> {
  return request<Association>(`/api/associations/${encodeURIComponent(id)}`);
}

export async function getAssociationBySlug(slug: string): Promise<Association> {
  return request<Association>(`/api/associations/slug/${encodeURIComponent(slug)}`);
}

export async function listMembers(associationId: string): Promise<AssociationMember[]> {
  return request<AssociationMember[]>(
    `/api/associations/${encodeURIComponent(associationId)}/members`
  );
}

// ── Authenticated ─────────────────────────────────────────────────────────

export async function listMyAssociations(): Promise<Association[]> {
  return request<Association[]>('/api/associations/me/list');
}

export async function listMyFollowedAssociations(): Promise<
  Pick<Association, 'id' | 'name' | 'slug' | 'logoUrl'>[]
> {
  return request<Pick<Association, 'id' | 'name' | 'slug' | 'logoUrl'>[]>(
    '/api/associations/me/following'
  );
}

export async function getAssociationFollowStatus(
  associationId: string
): Promise<{ following: boolean }> {
  return request<{ following: boolean }>(
    `/api/associations/${encodeURIComponent(associationId)}/follow-status`
  );
}

export async function followAssociation(associationId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/associations/${encodeURIComponent(associationId)}/follow`, {
    method: 'POST',
  });
}

export async function unfollowAssociation(associationId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/associations/${encodeURIComponent(associationId)}/follow`, {
    method: 'DELETE',
  });
}

export async function createAssociation(payload: CreateAssociationPayload): Promise<Association> {
  return request<Association>('/api/associations', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ── Admin / Owner ─────────────────────────────────────────────────────────

export async function updateAssociation(
  id: string,
  payload: UpdateAssociationPayload
): Promise<Association> {
  return request<Association>(`/api/associations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function deleteAssociation(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/associations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function uploadAssociationLogo(
  associationId: string,
  file: File
): Promise<Association> {
  const base = socialUrl();
  const token = await getToken().catch(() => '');
  const fd = new FormData();
  fd.append('file', file);
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}/api/associations/${encodeURIComponent(associationId)}/logo`, {
    method: 'POST',
    headers,
    body: fd,
  });
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`associations ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as Association;
}

export async function deleteAssociationLogo(associationId: string): Promise<Association> {
  return request<Association>(`/api/associations/${encodeURIComponent(associationId)}/logo`, {
    method: 'DELETE',
  });
}

export async function addMember(
  associationId: string,
  userId: string,
  role: string,
  permission: 0 | 1
): Promise<AssociationMember> {
  return request<AssociationMember>(
    `/api/associations/${encodeURIComponent(associationId)}/members`,
    { method: 'POST', body: JSON.stringify({ userId, role, permission }) }
  );
}

export async function updateMemberRole(
  associationId: string,
  userId: string,
  role?: string,
  permission?: 0 | 1
): Promise<AssociationMember> {
  return request<AssociationMember>(
    `/api/associations/${encodeURIComponent(associationId)}/members/${encodeURIComponent(userId)}`,
    { method: 'PATCH', body: JSON.stringify({ role, permission }) }
  );
}

export async function removeMember(
  associationId: string,
  userId: string
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/associations/${encodeURIComponent(associationId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' }
  );
}

// ── Stripe onboarding ───────────────────────────────────────────────────────

export async function startStripeOnboarding(
  associationId: string,
  existingAccountId?: string,
  opts?: { returnUrl?: string; refreshUrl?: string }
): Promise<{ url: string; accountId: string }> {
  const base = coreUrl();
  const res = await apiFetch(`${base}/api/payments/onboarding`, {
    method: 'POST',
    body: JSON.stringify({
      associationId,
      existingAccountId,
      returnUrl: opts?.returnUrl,
      refreshUrl: opts?.refreshUrl,
    }),
  });
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`onboarding ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as { url: string; accountId: string };
}
