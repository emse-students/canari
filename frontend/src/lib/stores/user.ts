import { apiFetch } from '$lib/utils/apiFetch';
import { setCurrentUserId } from '$lib/stores/userState.svelte';

export { currentUserId } from '$lib/stores/userState.svelte';

export interface UserProfile {
  id: string;
  email: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  promo: number | null;
  avatarMediaId: string | null;
  bio: string | null;
  createdAt: string;
}

const USER_STORAGE_KEY = 'canari_saved_user';
const USER_EMAIL_KEY = 'canari_user_email';
const USER_DISPLAY_NAME_KEY = 'canari_user_display_name';
const USER_GLOBAL_ADMIN_KEY = 'canari_global_admin';

export function getSavedUserId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(USER_STORAGE_KEY);
}

export function getSavedDisplayName(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(USER_DISPLAY_NAME_KEY);
}

export function getSavedEmail(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(USER_EMAIL_KEY);
}

export function isGlobalAdmin(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(USER_GLOBAL_ADMIN_KEY) === 'true';
}

export function saveUserLocally(user: {
  id: string;
  email?: string;
  displayName?: string;
  admin?: boolean;
}): void {
  localStorage.setItem(USER_STORAGE_KEY, user.id);
  if (user.email) localStorage.setItem(USER_EMAIL_KEY, user.email);
  if (user.displayName) localStorage.setItem(USER_DISPLAY_NAME_KEY, user.displayName);
  localStorage.setItem(USER_GLOBAL_ADMIN_KEY, user.admin ? 'true' : 'false');
  setCurrentUserId(user.id);
}

export function clearUserLocally(): void {
  localStorage.removeItem(USER_STORAGE_KEY);
  localStorage.removeItem(USER_EMAIL_KEY);
  localStorage.removeItem(USER_DISPLAY_NAME_KEY);
  localStorage.removeItem(USER_GLOBAL_ADMIN_KEY);
  setCurrentUserId(null);
}

function coreUrl(): string {
  const url =
    typeof import.meta !== 'undefined'
      ? ((import.meta as any).env?.VITE_CORE_URL as string | undefined)
      : undefined;
  if (url?.trim()) return url.trim();
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3012';
}

export async function fetchMyProfile(): Promise<UserProfile> {
  const res = await apiFetch(`${coreUrl()}/api/users/me`);
  if (!res.ok) {
    throw new Error(`Failed to fetch profile (${res.status})`);
  }
  return (await res.json()) as UserProfile;
}

export async function fetchUserProfile(userId: string): Promise<UserProfile> {
  const res = await apiFetch(`${coreUrl()}/api/users/${encodeURIComponent(userId)}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch user (${res.status})`);
  }
  return (await res.json()) as UserProfile;
}

export async function updateMyProfile(data: {
  bio?: string;
  avatarMediaId?: string;
}): Promise<UserProfile> {
  const res = await apiFetch(`${coreUrl()}/api/users/me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error(`Failed to update profile (${res.status})`);
  }
  return (await res.json()) as UserProfile;
}
