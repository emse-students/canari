import { getToken, refresh } from '$lib/stores/auth';
import { MlsDeliveryApi, type MlsDeliveryFetch } from './mlsDeliveryApi';

/**
 * The delivery API every MLS service uses: the auth store's token, and its renewal, so every route
 * obeys the one 401 rule (`renewOn401.ts`). The renewal is OPTIONAL in `MlsDeliveryApiOptions` only so
 * a test can read a single response; this is the one construction that ships, and
 * `productionDeliveryApi.test.ts` fails if it ever stops passing it.
 *
 * `refresh` is passed as a closure so the auth store's export is read when a 401 asks for it.
 */
export function productionDeliveryApi(
  historyUrl: string,
  fetchImpl?: MlsDeliveryFetch
): MlsDeliveryApi {
  return new MlsDeliveryApi({
    historyUrl,
    getToken,
    refreshToken: () => refresh(),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
