import type { PushAuth } from '$lib/services/PushNotificationService';

/**
 * A push registration's token source that always holds the same live token, for the cases that
 * test something other than the 401 rule (`PushNotificationService.refusal.test.ts` covers that).
 */
export const JWT_AUTH: PushAuth = {
  tokenNow: async () => 'jwt',
  renew: async () => 'jwt',
};
