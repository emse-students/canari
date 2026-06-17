import { apiFetch } from '$lib/utils/apiFetch';
import { setCurrentUserId, setGlobalAdmin } from '$lib/stores/userState.svelte';
import { coreUrl } from '$lib/utils/apiUrl';

export {
  currentUserId,
  globalAdminState as isGlobalAdmin,
  associationSuperAdminState as isAssociationSuperAdmin,
} from '$lib/stores/userState.svelte';

/** Full profile returned by the `/api/users/me` and `/api/users/:id` endpoints. */
export interface UserProfile {
  id: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  /** School entry year (used for promo grouping). */
  promo: number | null;
  /** Academic programme/track. */
  formation: string | null;
  /** Media ID of the uploaded avatar, or `null` if using the generated placeholder. */
  avatarMediaId: string | null;
  bio: string | null;
  createdAt: string;
}

const USER_STORAGE_KEY = 'canari_saved_user';
const USER_EMAIL_KEY = 'canari_user_email';
const USER_DISPLAY_NAME_KEY = 'canari_user_display_name';
const USER_GLOBAL_ADMIN_KEY = 'canari_global_admin';

/** Returns the persisted user ID from localStorage, or `null` if not logged in. */
export function getSavedUserId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(USER_STORAGE_KEY);
}

/** Returns the persisted display name from localStorage, or `null` if not available. */
export function getSavedDisplayName(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(USER_DISPLAY_NAME_KEY);
}

/** Returns the persisted email address from localStorage, or `null` if not available. */
export function getSavedEmail(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(USER_EMAIL_KEY);
}

/**
 * Persists the user's identity fields to localStorage and updates the reactive
 * Svelte 5 state so components that read `currentUserId()` or `globalAdminState()`
 * re-render immediately.
 */
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
  setGlobalAdmin(!!user.admin);
  setCurrentUserId(user.id);
}

/** Removes all persisted user data from localStorage and resets reactive state to logged-out. */
export function clearUserLocally(): void {
  localStorage.removeItem(USER_STORAGE_KEY);
  localStorage.removeItem(USER_EMAIL_KEY);
  localStorage.removeItem(USER_DISPLAY_NAME_KEY);
  localStorage.removeItem(USER_GLOBAL_ADMIN_KEY);
  setGlobalAdmin(false);
  setCurrentUserId(null);
}

/** Fetches the authenticated user's own profile from the core service. */
export async function fetchMyProfile(): Promise<UserProfile> {
  const res = await apiFetch(`${coreUrl()}/api/users/me`);
  if (!res.ok) {
    throw new Error(`Failed to fetch profile (${res.status})`);
  }
  return (await res.json()) as UserProfile;
}

/** In-flight / short-lived cache for user profiles. TTL: 30 s. Deduplicates simultaneous fetches. */
const profileCache = new Map<string, { promise: Promise<UserProfile>; expiresAt: number }>();

/** Fetches the public profile of another user by their Canari user ID. */
export function fetchUserProfile(userId: string): Promise<UserProfile> {
  const now = Date.now();
  const cached = profileCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise = apiFetch(`${coreUrl()}/api/users/${encodeURIComponent(userId)}`).then(
    async (res) => {
      if (!res.ok) throw new Error(`Failed to fetch user (${res.status})`);
      return (await res.json()) as UserProfile;
    }
  );

  // Cache the promise so concurrent callers share the in-flight request.
  // On rejection, evict immediately so the next caller retries rather than
  // receiving the same cached error.
  profileCache.set(userId, { promise, expiresAt: now + 30_000 });
  promise.catch(() => profileCache.delete(userId));
  return promise;
}

/** Searches users by display name (case-insensitive). Returns up to 10 results. */
export async function searchUsers(
  q: string
): Promise<Array<{ id: string; displayName: string | null }>> {
  if (!q.trim()) return [];
  const res = await apiFetch(`${coreUrl()}/api/users/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) return [];
  return (await res.json()) as Array<{ id: string; displayName: string | null }>;
}

/** Returns `true` if a user with the given ID exists on the platform. */
export async function userExists(userId: string): Promise<boolean> {
  try {
    await fetchUserProfile(userId);
    return true;
  } catch {
    return false;
  }
}

/** Updates the authenticated user's mutable profile fields (bio and/or avatar). */
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

// ── Payment Methods ─────────────────────────────────────────────────────

/** A saved Stripe payment method (card) returned by the core service. */
export interface PaymentMethod {
  /** Stripe payment method ID. */
  id: string;
  /** Card network (e.g. `"visa"`, `"mastercard"`). */
  brand: string;
  /** Last four digits of the card number. */
  last4: string;
  expMonth: number;
  expYear: number;
}

/**
 * Initiates a Stripe SetupIntent flow to save a new payment method.
 * Returns a redirect URL to the Stripe-hosted form when `url` is present.
 */
export async function setupPaymentMethod(callbacks?: {
  successUrl?: string;
  cancelUrl?: string;
}): Promise<{ ok: boolean; url?: string }> {
  const res = await apiFetch(`${coreUrl()}/api/payments/setup-payment-method`, {
    method: 'POST',
    body: JSON.stringify(callbacks ?? {}),
  });
  if (!res.ok) throw new Error(`Failed to start payment setup (${res.status})`);
  return (await res.json()) as { ok: boolean; url?: string };
}

/** Returns all saved Stripe payment methods for the current user. */
export async function listPaymentMethods(): Promise<PaymentMethod[]> {
  const res = await apiFetch(`${coreUrl()}/api/payments/payment-methods`);
  if (!res.ok) throw new Error(`Failed to fetch payment methods (${res.status})`);
  return (await res.json()) as PaymentMethod[];
}

/**
 * Permanently deletes the authenticated user's account and all associated data.
 * Throws if the server returns a non-204 response.
 * The caller is responsible for clearing local auth state and redirecting to /login.
 */
export async function deleteMyAccount(): Promise<void> {
  const res = await apiFetch(`${coreUrl()}/api/users/me`, { method: 'DELETE' });
  if (res.status !== 204) {
    throw new Error(`Account deletion failed (${res.status})`);
  }
}

/** Deletes a saved Stripe payment method by its ID. */
export async function deletePaymentMethod(id: string): Promise<void> {
  const res = await apiFetch(
    `${coreUrl()}/api/payments/payment-methods/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
    }
  );
  if (!res.ok) throw new Error(`Failed to delete payment method (${res.status})`);
}

/**
 * Charges a form submission using a previously saved Stripe payment method.
 * May return `requiresAction: true` with a `clientSecret` if 3D Secure is needed.
 */
export async function chargeWithSavedMethod(
  submissionId: string,
  paymentMethodId: string
): Promise<{ ok: boolean; requiresAction?: boolean; clientSecret?: string; error?: string }> {
  const res = await apiFetch(`${coreUrl()}/api/payments/charge-saved-method`, {
    method: 'POST',
    body: JSON.stringify({ submissionId, paymentMethodId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message || `Payment failed (${res.status})`);
  }
  return (await res.json()) as {
    ok: boolean;
    requiresAction?: boolean;
    clientSecret?: string;
    error?: string;
  };
}

/**
 * Charges a boutique product using a previously saved Stripe payment method.
 * May return `requiresAction: true` with a `clientSecret` if 3D Secure is needed.
 */
export async function chargeProductWithSavedMethod(
  associationId: string,
  productId: string,
  paymentMethodId: string,
  customAmountCents?: number
): Promise<{ ok: boolean; requiresAction?: boolean; clientSecret?: string; error?: string }> {
  const res = await apiFetch(`${coreUrl()}/api/payments/charge-product-saved-method`, {
    method: 'POST',
    body: JSON.stringify({
      associationId,
      productId,
      paymentMethodId,
      ...(customAmountCents !== undefined ? { customAmountCents } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message || `Payment failed (${res.status})`);
  }
  return (await res.json()) as {
    ok: boolean;
    requiresAction?: boolean;
    clientSecret?: string;
    error?: string;
  };
}
