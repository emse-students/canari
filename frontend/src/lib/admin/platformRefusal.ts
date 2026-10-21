import { Log } from '$lib/utils/Log';

/**
 * The typed codes core-service puts in the body of a platform-admin refusal - the copy of
 * `PLATFORM_ERROR_CODES` in `apps/core-service/src/platform/platform.service.ts`, pinned to it by
 * `platformRefusal.test.ts`. The admin screen maps a refusal by CODE, never by its English prose.
 */
export const PLATFORM_ERROR_CODES = {
  /** 502: the payment provider IS saved, but the withheld products were not all released. */
  WITHHELD_RELEASE_INCOMPLETE: 'WITHHELD_RELEASE_INCOMPLETE',
  /** 400: the release action was asked while payments are disabled platform-wide. */
  PAYMENTS_DISABLED: 'PAYMENTS_DISABLED',
} as const;

/** What a platform-admin refusal body may carry; `config` is the saved state on a partial failure. */
export type PlatformRefusal<Config> = { code: string | null; config: Config | null };

/**
 * Reads the code (and the saved config, when the server sent it) out of a refused response.
 * A body that is not JSON, or carries no code, answers `code: null` - an untyped refusal.
 */
export async function readPlatformRefusal<Config>(res: Response): Promise<PlatformRefusal<Config>> {
  try {
    const body = (await res.json()) as { code?: unknown; config?: unknown } | null;
    const code = typeof body?.code === 'string' ? body.code : null;
    const config = body?.config && typeof body.config === 'object' ? (body.config as Config) : null;
    Log.d(`admin.platform refusal status=${res.status} code=${code ?? 'none'}`);
    return { code, config };
  } catch (e) {
    Log.d(`admin.platform refusal status=${res.status} has no JSON body`, e);
    return { code: null, config: null };
  }
}
