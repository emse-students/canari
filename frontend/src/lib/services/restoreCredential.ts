/**
 * ACCOUNT RESTORE ON A NEW ANDROID PHONE - the two flows of WP-RESTORE-1 (docs/wiki/account-restore.md).
 *
 * - {@link registerRestoreKeyIfDue}: a signed-in session registers ONE restore key, which Android
 *   keeps in the phone's Google backup.
 * - {@link attemptRestore}: on the first start of a fresh install, `/login` asks the platform for a
 *   restored key; the server answers a verified one by MOVING the session that registered it here
 *   (the old phone is signed out - a restore is a transfer, never an extra session).
 *
 * What a restore gives is a SESSION and nothing else: no MLS key, no message. The new phone then
 * starts exactly as after a MiConnect sign-in.
 *
 * Every refusal is a CODE read from the response body, never prose; every outcome is logged.
 */

import { m } from '$lib/paraglide/messages';
import { apiFetch } from '$lib/utils/apiFetch';
import { coreUrl } from '$lib/utils/apiUrl';
import { isTransportFailure } from '$lib/utils/transportFailure';
import { adoptRestoredSession, type SignedInSession } from '$lib/stores/auth';
import { sessionScopedHeaders } from '$lib/services/authSessions';
import {
  clearRestoreKey,
  createRestoreKey,
  getRestoreKey,
  hasAttemptedRestore,
  isRestoreKeyRegistered,
  markRestoreAttempted,
  markRestoreKeyRegistered,
  restoreKeySupported,
} from '$lib/services/restoreKey';

const rlog = (msg: string) => console.log('[RESTORE] ' + msg);
const rwarn = (msg: string) => console.warn('[RESTORE] ' + msg);

/** A route of `/api/auth/restore`. */
function restoreUrl(path: string): string {
  return `${coreUrl()}/api/auth/restore/${path}`;
}

/** A refusal the server classified at its throw: the code decides, the message is for the log. */
export interface RestoreRefusal {
  status: number;
  code: string | null;
  message: string | null;
}

/**
 * Reads the code out of a refusal body. Nest answers an `HttpException` built from an object with
 * that object (`{ code, message }`); the maintenance refusal of the sign-in nests it under
 * `message`. Both shapes are read, as the MiConnect callback reads them.
 */
export async function readRestoreRefusal(res: Response): Promise<RestoreRefusal> {
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as {
      code?: string;
      message?: string | { code?: string; message?: string };
    };
    const nested = typeof parsed.message === 'object' ? parsed.message : undefined;
    return {
      status: res.status,
      code: parsed.code ?? nested?.code ?? null,
      message: (typeof parsed.message === 'string' ? parsed.message : nested?.message) ?? null,
    };
  } catch {
    return { status: res.status, code: null, message: text || null };
  }
}

/** Thrown when a registration is refused by the server: carries its code for the log line. */
export class RestoreRegistrationRefusedError extends Error {
  constructor(readonly refusal: RestoreRefusal) {
    super(
      `restore key registration refused: ${refusal.status} ${refusal.code ?? 'no code'} ${refusal.message ?? ''}`.trim()
    );
    this.name = 'RestoreRegistrationRefusedError';
  }
}

/**
 * Registers this session's restore key, unless it already has one. Android only; called after a
 * login that reached the server (`loginImpl`, `promoteOfflineSession`), fire-and-forget.
 *
 * Throws on any failure (the caller logs it): the marker is then left unset, so the next start
 * tries again. A registration is idempotent server-side - one key per session, a second replaces
 * the first.
 */
export async function registerRestoreKeyIfDue(userId: string): Promise<void> {
  if (!restoreKeySupported()) return;
  if (!userId) {
    rwarn('register skipped: no signed-in user id');
    return;
  }
  if (isRestoreKeyRegistered(userId)) {
    console.debug('[RESTORE] register skipped: this session already has its key');
    return;
  }
  rlog('register: asking for options');
  // `credentials: 'include'` keeps the call on the WebView's own fetch, so it carries the cookie
  // AND the app's `Origin`, which is what the server admits a registration from.
  const optionsRes = await apiFetch(restoreUrl('registration/options'), {
    method: 'POST',
    credentials: 'include',
    headers: await sessionScopedHeaders(),
  });
  if (!optionsRes.ok)
    throw new RestoreRegistrationRefusedError(await readRestoreRefusal(optionsRes));
  const options: unknown = await optionsRes.json();

  const created = await createRestoreKey(options);
  if (!created.cloudBackup) {
    // The Kotlin side has logged the cause at error; this line says what it costs the user.
    rwarn('register: the key is NOT in the cloud backup - a lost phone will not restore');
  }

  const res = await apiFetch(restoreUrl('registration'), {
    method: 'POST',
    credentials: 'include',
    headers: await sessionScopedHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      response: JSON.parse(created.responseJson) as unknown,
      cloudBackup: created.cloudBackup,
    }),
  });
  if (!res.ok) throw new RestoreRegistrationRefusedError(await readRestoreRefusal(res));
  markRestoreKeyRegistered(userId);
  rlog(`register✓ (cloudBackup=${created.cloudBackup})`);
}

/** How an attempt ended - what `/login` does next is read from this, never from a log line. */
export type RestoreAttempt =
  /** A session was restored and adopted: go where a sign-in goes. */
  | { outcome: 'restored'; userId: string }
  /** Not this platform, or not the first start of this install. Nothing was asked. */
  | { outcome: 'not-applicable' }
  /** The platform holds no restored key: the ordinary sign-in. */
  | { outcome: 'nothing-to-restore' }
  /** The server or the platform said no. `shown` is the sentence for the sign-in card, if any. */
  | { outcome: 'refused'; code: string | null; shown: string | null }
  /** No answer: nothing is recorded, so the next visit of `/login` asks again. */
  | { outcome: 'unreachable' };

/**
 * The server's refusals that are NOT a verdict on this install's key: the estate cannot answer
 * (not configured, maintenance, a 5xx). The attempt is left un-recorded, so a later visit asks again.
 */
function isServerStateRefusal(refusal: RestoreRefusal): boolean {
  return (
    refusal.code === 'RESTORE_UNAVAILABLE' ||
    refusal.code === 'MAINTENANCE' ||
    refusal.status >= 500
  );
}

/** What the sign-in card says for a refusal that has a sentence - the MiConnect sign-in's own. */
function shownFor(refusal: RestoreRefusal): string | null {
  if (refusal.code === 'ACCOUNT_ERASURE_PENDING') return m.auth_account_erasure_pending();
  if (refusal.code === 'ACCOUNT_ERASURE_BLOCKED') return m.auth_account_erasure_blocked();
  if (refusal.code === 'MAINTENANCE') return refusal.message || m.auth_maintenance_default();
  return null;
}

/**
 * Classifies a refusal, records the attempt when it is a verdict, and clears a key the server no
 * longer knows. One place, so the options call and the assertion call cannot disagree.
 */
async function refused(stage: string, refusal: RestoreRefusal): Promise<RestoreAttempt> {
  const line = `${stage} refused: ${refusal.status} ${refusal.code ?? 'no code'}`;
  if (refusal.code === 'RESTORE_ASSERTION_INVALID') {
    // A key this server registered failed to verify: a defect, never an ordinary outcome.
    console.error(`[RESTORE] ${line} - a registered key did not verify`);
  } else {
    rwarn(line);
  }
  if (refusal.code === 'RESTORE_KEY_UNKNOWN') await clearRestoreKey('unknown to the server');
  if (!isServerStateRefusal(refusal)) markRestoreAttempted();
  return { outcome: 'refused', code: refusal.code, shown: shownFor(refusal) };
}

/**
 * Attempts the restore of a session onto this install. Android only, and only on the first start
 * of a fresh install (`hasAttemptedRestore`): the caller is `/login` with no saved user.
 *
 * Never throws. A transport failure leaves the attempt un-recorded; every other end records it.
 */
export async function attemptRestore(): Promise<RestoreAttempt> {
  if (!restoreKeySupported()) return { outcome: 'not-applicable' };
  if (hasAttemptedRestore()) {
    console.debug('[RESTORE] attempt skipped: this install is past its first start');
    return { outcome: 'not-applicable' };
  }
  rlog('attempt: asking for options');
  try {
    // Anonymous: there is no session yet. Plain `fetch`, `credentials: 'include'` so the session
    // cookie the answer sets lands in the WebView's own jar.
    const optionsRes = await fetch(restoreUrl('assertion/options'), {
      method: 'POST',
      credentials: 'include',
    });
    if (!optionsRes.ok) return await refused('options', await readRestoreRefusal(optionsRes));
    const options: unknown = await optionsRes.json();

    let found;
    try {
      found = await getRestoreKey(options);
    } catch (e) {
      // The platform's provider failed - not "no key", which is an answer (`absent`).
      console.error(`[RESTORE] attempt: the platform failed to answer: ${String(e)}`);
      markRestoreAttempted();
      return { outcome: 'refused', code: null, shown: null };
    }
    if (found.absent) {
      rlog('attempt: nothing to restore on this phone');
      markRestoreAttempted();
      return { outcome: 'nothing-to-restore' };
    }

    const res = await fetch(restoreUrl('assertion'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: JSON.parse(found.responseJson) as unknown }),
    });
    if (!res.ok) return await refused('assertion', await readRestoreRefusal(res));
    const data = (await res.json()) as SignedInSession;
    await adoptRestoredSession(data);
    rlog(`attempt✓ session restored for ${data.user.id.slice(0, 8)}`);
    return { outcome: 'restored', userId: data.user.id };
  } catch (e) {
    if (isTransportFailure(e)) {
      rwarn(`attempt: no answer (${String(e)}) - the next visit asks again`);
      return { outcome: 'unreachable' };
    }
    console.error(`[RESTORE] attempt failed: ${String(e)}`);
    markRestoreAttempted();
    return { outcome: 'refused', code: null, shown: null };
  }
}
