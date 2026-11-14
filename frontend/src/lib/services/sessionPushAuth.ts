import { getToken, refresh } from '$lib/stores/auth';
import type { PushAuth } from './PushNotificationService';

/**
 * The token source every push registration uses: the auth store's CURRENT token for each attempt,
 * and its single-flight renewal on a 401 (`renewOn401.ts`). In its own module because the auth store
 * imports `PushNotificationService` (the sign-out ends the registration), so the service cannot
 * import the store back; this is the one construction that ships.
 *
 * Both are closures, so the auth store's exports are read when an attempt asks for them.
 */
export const sessionPushAuth: PushAuth = {
  tokenNow: () => getToken(),
  renew: () => refresh(fetch, 'push registration answered 401'),
};
