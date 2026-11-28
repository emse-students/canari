import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { Log } from '$lib/utils/Log';
import type { MailCaller } from './mailApi';
import { parsePrefs } from './zimbraParse';
import { getPrefsRequest, modifyPrefsRequest } from './zimbraRequests';

/**
 * THE ACCOUNT'S OWN ZIMBRA NEW-MAIL ALERT, POINTED AT AN OPAQUE ADDRESS - MAIL LOT 5'S CLIENT HALF
 * (docs/wiki/mail-client-transport.md#as-built---lot-5; D11, owner 2026-11-28).
 *
 * While `mail_push = cloudflare` and the account wants notifications on a phone, the device sets the
 * account's OWN alert (`zimbraPrefNewMailNotificationEnabled` / `...Address`, the two preferences
 * Partage lets a user set - `zimbraFeatureNewMailNotificationEnabled` is TRUE there, measured
 * 2026-11-27) to `n-<128 random bits>@<the estate's alert domain>`, and subscribes itself with
 * Canari's server under that token. Cloudflare's Email Worker turns each alert into a post of the
 * token alone, and the server into an EMPTY push. The device then reads the mail itself.
 *
 * THE ALERT'S TEXT IS NOT OURS TO SET. Zimbra builds it from `zimbraNewMailNotificationSubject` /
 * `Body` / `From`, which are COS or account ATTRIBUTES a domain admin sets (`domainAdminModifiable`),
 * not preferences: `ModifyPrefsRequest` takes `zimbraPref*` names only. So the alert Cloudflare
 * receives carries Partage's default text - by Zimbra's defaults the recipient, the sender's address
 * and the subject. The Worker reads only the envelope recipient and drops the message; what
 * Cloudflare's mail servers see in transit is an open question for the owner
 * (docs/wiki/open-questions.md), and the reason the switch is the admin's, off by default.
 *
 * ONLY OUR OWN ADDRESS IS EVER TOUCHED (an allowlist, never a denylist): the alert is overwritten
 * only after the preferences it held were saved on this device, and restored only while it still
 * names an address of Canari's shape. An alert the user pointed elsewhere since is left alone.
 *
 * Every step is IDEMPOTENT and decided from durable facts - the preferences Zimbra answers, the
 * server's state, the device's record - never from a clock: the controller calls {@link syncMailAlert}
 * whenever a fact changes and it converges.
 */

/** The two preferences of the alert, in the order every read and write names them. */
export const ALERT_ENABLED_PREF = 'zimbraPrefNewMailNotificationEnabled';
/** See {@link ALERT_ENABLED_PREF}. */
export const ALERT_ADDRESS_PREF = 'zimbraPrefNewMailNotificationAddress';
const ALERT_PREFS = [ALERT_ENABLED_PREF, ALERT_ADDRESS_PREF] as const;

/** The alert's preferences as Zimbra holds them; `''` is "never set" (and writes back as unset). */
export interface AlertPrefs {
  enabled: string;
  address: string;
}

/** The preferences of an alert that is off and was never set: what an unknown original restores to. */
export const ALERT_UNSET: AlertPrefs = { enabled: '', address: '' };

/** An address of Canari's shape, whatever its domain: `n-` and 32 hex characters as the local part. */
const CANARI_ADDRESS = /^n-([0-9a-f]{32})@([^@\s]+)$/i;

/** The opaque address of `token` on `domain`. */
export function alertAddress(token: string, domain: string): string {
  return `n-${token}@${domain.toLowerCase()}`;
}

/** The token and domain of an address of Canari's shape, or `null` for any other address. */
export function parseAlertAddress(address: string): { token: string; domain: string } | null {
  const match = CANARI_ADDRESS.exec(address.trim());
  return match ? { token: match[1].toLowerCase(), domain: match[2].toLowerCase() } : null;
}

/** 128 random bits as 32 lower-case hex characters. */
export function newAlertToken(
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b)
): string {
  return [...random(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What this device keeps (`ACCOUNT_KEY.mailAlert`, one of the D8 keys). */
export interface MailAlertRecord {
  v: 1;
  /** Whether this device subscribed with the server. */
  subscribed: boolean;
  /** The alert as it was before Canari set it, saved BEFORE the first write; `null` when unknown. */
  saved: AlertPrefs | null;
}

/** The record of `userId`, or `null` (none, or unreadable - logged). */
export function readAlertRecord(userId: string, store: Storage): MailAlertRecord | null {
  try {
    const raw = store.getItem(ACCOUNT_KEY.mailAlert(userId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<MailAlertRecord>;
    const saved = parsed.saved;
    const savedOk =
      saved === null ||
      (typeof saved === 'object' &&
        typeof saved?.enabled === 'string' &&
        typeof saved?.address === 'string');
    if (parsed.v !== 1 || typeof parsed.subscribed !== 'boolean' || !savedOk) {
      Log.w('MAIL-ALERT', 'ERROR: the alert record is not one this build wrote - ignored');
      return null;
    }
    return { v: 1, subscribed: parsed.subscribed, saved: saved ?? null };
  } catch (err) {
    Log.w('MAIL-ALERT', `ERROR: the alert record could not be read (${String(err)})`);
    return null;
  }
}

function writeAlertRecord(userId: string, record: MailAlertRecord | null, store: Storage): void {
  if (record === null) store.removeItem(ACCOUNT_KEY.mailAlert(userId));
  else store.setItem(ACCOUNT_KEY.mailAlert(userId), JSON.stringify(record));
}

/** What Canari's server answers about the account's alert (`POST /api/mls/mail-alert/state`). */
export interface MailAlertServerState {
  mode: 'none' | 'cloudflare';
  domain: string | null;
  deviceSubscribed: boolean;
  tokenLive: boolean;
  devices: number;
}

/** A refusal of the server, TYPED from its `error` field - never from its prose. */
export class MailAlertServerError extends Error {
  constructor(
    readonly kind: 'off' | 'unconfigured' | 'not_registered' | 'refused',
    readonly status: number
  ) {
    super(`mail alert server refused: ${kind} (${status})`);
  }
}

/** The server routes, as the controller wires them (a test hands a fake). */
export interface MailAlertServer {
  state(deviceId: string, token: string | null): Promise<MailAlertServerState>;
  subscribe(deviceId: string, token: string): Promise<{ domain: string }>;
  unsubscribe(deviceId: string): Promise<{ remaining: number }>;
}

/** What one {@link syncMailAlert} did, for the log and the tests. */
export type MailAlertOutcome =
  /** The alert was pointed at a new token of this device. */
  | 'configured'
  /** The alert already named the account's live token; this device joined it. */
  | 'joined'
  /** Nothing to do: already as wanted. */
  | 'unchanged'
  /** This device left; others still want the push, so the alert stays. */
  | 'left'
  /** This device was the last: the alert is back as it was before Canari (or unset). */
  | 'restored'
  /** An alert of Canari's shape nobody listens to any more was turned off. */
  | 'repaired'
  /** The server's switch is `none`: nothing may be configured. */
  | 'off'
  /** The estate has no alert domain. */
  | 'unconfigured'
  /** This install has no device id yet (no Canari device). */
  | 'no_device';

/** What {@link syncMailAlert} works with. */
export interface MailAlertDeps {
  userId: string;
  /** This install's Canari device id (`ACCOUNT_KEY.deviceId`), `null` before it exists. */
  deviceId: string | null;
  /** The mailbox, signed in. */
  mailbox: Pick<MailCaller, 'call'>;
  server: MailAlertServer;
  store: Storage;
}

async function readAlertPrefs(mailbox: MailAlertDeps['mailbox']): Promise<AlertPrefs> {
  const prefs = parsePrefs(await mailbox.call(getPrefsRequest(ALERT_PREFS)), ALERT_PREFS);
  return { enabled: prefs[ALERT_ENABLED_PREF], address: prefs[ALERT_ADDRESS_PREF] };
}

async function writeAlertPrefs(
  mailbox: MailAlertDeps['mailbox'],
  prefs: AlertPrefs
): Promise<void> {
  await mailbox.call(
    modifyPrefsRequest({ [ALERT_ENABLED_PREF]: prefs.enabled, [ALERT_ADDRESS_PREF]: prefs.address })
  );
}

/** Whether Zimbra's boolean preference reads as on (`TRUE`, any case). */
function isOn(value: string): boolean {
  return value.toUpperCase() === 'TRUE';
}

/**
 * Brings the account's alert to what this device wants: `want` true points it at Canari (or joins
 * the token already there), false takes this device out and, when it was the last, restores the
 * alert. Idempotent; throws what the mailbox or the server threw (the caller logs and retries on the
 * next fact).
 */
export async function syncMailAlert(deps: MailAlertDeps, want: boolean): Promise<MailAlertOutcome> {
  const record = readAlertRecord(deps.userId, deps.store);
  if (want) return ensureAlert(deps, record);
  if (record?.subscribed || record?.saved) return releaseAlert(deps, record);
  return repairOrphanAlert(deps);
}

async function ensureAlert(
  deps: MailAlertDeps,
  record: MailAlertRecord | null
): Promise<MailAlertOutcome> {
  const { userId, deviceId, mailbox, server, store } = deps;
  if (!deviceId) {
    Log.i('MAIL-ALERT', 'no device id yet - the alert waits for one');
    return 'no_device';
  }
  const prefs = await readAlertPrefs(mailbox);
  const current = parseAlertAddress(prefs.address);
  const state = await server.state(deviceId, current?.token ?? null);
  if (state.mode !== 'cloudflare') return 'off';
  if (!state.domain) {
    Log.w('MAIL-ALERT', 'ERROR: the server has no alert domain - nothing configured');
    return 'unconfigured';
  }
  if (current && state.tokenLive && current.domain === state.domain && isOn(prefs.enabled)) {
    if (state.deviceSubscribed && record?.subscribed) return 'unchanged';
    await server.subscribe(deviceId, current.token);
    writeAlertRecord(userId, { v: 1, subscribed: true, saved: record?.saved ?? null }, store);
    Log.i('MAIL-ALERT', `joined the account's live alert (devices=${state.devices + 1})`);
    return 'joined';
  }
  // The original is saved BEFORE anything is written, and never overwritten by a value of ours: an
  // address of Canari's shape (a stale token, another estate's domain) is not the user's, so the
  // original is then unknown and restores to unset.
  const saved = record?.saved ?? (current ? ALERT_UNSET : prefs);
  writeAlertRecord(userId, { v: 1, subscribed: record?.subscribed ?? false, saved }, store);
  const token = newAlertToken();
  const { domain } = await server.subscribe(deviceId, token);
  writeAlertRecord(userId, { v: 1, subscribed: true, saved }, store);
  try {
    await writeAlertPrefs(mailbox, { enabled: 'TRUE', address: alertAddress(token, domain) });
  } catch (err) {
    Log.w('MAIL-ALERT', 'ERROR: the alert was not written - the subscription is taken back');
    await server
      .unsubscribe(deviceId)
      .then(() => writeAlertRecord(userId, { v: 1, subscribed: false, saved }, store))
      .catch((e: unknown) => Log.w('MAIL-ALERT', `ERROR: the subscription stays (${String(e)})`));
    throw err;
  }
  Log.i(
    'MAIL-ALERT',
    `the alert now names this device's token (original saved: ${saved !== ALERT_UNSET})`
  );
  return 'configured';
}

async function releaseAlert(
  deps: MailAlertDeps,
  record: MailAlertRecord
): Promise<MailAlertOutcome> {
  const { userId, deviceId, mailbox, server, store } = deps;
  if (!deviceId) {
    Log.w('MAIL-ALERT', 'ERROR: a record with no device id - left for the next fact');
    return 'no_device';
  }
  if (record.subscribed) {
    await server.unsubscribe(deviceId);
    writeAlertRecord(userId, { v: 1, subscribed: false, saved: record.saved }, store);
  }
  const prefs = await readAlertPrefs(mailbox);
  const current = parseAlertAddress(prefs.address);
  if (!current) {
    // The user pointed the alert elsewhere since: theirs, untouched.
    writeAlertRecord(userId, null, store);
    Log.i('MAIL-ALERT', 'the alert no longer names Canari - left as the user set it');
    return 'unchanged';
  }
  // Whether another device still listens is the SERVER's fact, read after this device left.
  const state = await server.state(deviceId, current.token);
  if (state.mode === 'cloudflare' && state.tokenLive) {
    // Others still listen: the alert stays. The original this device saved cannot be handed to them,
    // so it goes - the last device restores the alert to unset (documented limit).
    writeAlertRecord(userId, null, store);
    Log.i('MAIL-ALERT', `this device left the alert; ${state.devices} device(s) still listen`);
    return 'left';
  }
  await writeAlertPrefs(mailbox, record.saved ?? ALERT_UNSET);
  writeAlertRecord(userId, null, store);
  Log.i(
    'MAIL-ALERT',
    `the alert is restored (to ${record.saved ? 'the saved original' : 'unset'})`
  );
  return 'restored';
}

/**
 * A device that holds no record and does not want the push: if the alert still names an address of
 * Canari's shape and the server says nobody listens to it (or the switch is `none`), it is turned
 * OFF - a destructive repair gated on knowing the state is broken, touching only our own address.
 */
async function repairOrphanAlert(deps: MailAlertDeps): Promise<MailAlertOutcome> {
  const { deviceId, mailbox, server } = deps;
  if (!deviceId) return 'no_device';
  const prefs = await readAlertPrefs(mailbox);
  const current = parseAlertAddress(prefs.address);
  if (!current) return 'unchanged';
  const state = await server.state(deviceId, current.token);
  if (state.mode === 'cloudflare' && state.tokenLive) return 'unchanged';
  await writeAlertPrefs(mailbox, ALERT_UNSET);
  Log.w(
    'MAIL-ALERT',
    `an alert of Canari's shape nobody listens to was turned off (mode=${state.mode} live=${state.tokenLive})`
  );
  return 'repaired';
}

/** The production {@link MailAlertServer}: the delivery service's routes, with the session. */
export function httpMailAlertServer(
  fetcher: (path: string, body: unknown) => Promise<Response>
): MailAlertServer {
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetcher(path, body);
    if (res.ok) return (await res.json()) as T;
    let error: unknown;
    try {
      error = ((await res.json()) as { error?: unknown }).error;
    } catch (err) {
      Log.w('MAIL-ALERT', `ERROR: a refusal (${res.status}) with no JSON body (${String(err)})`);
      error = undefined;
    }
    const kind =
      error === 'mail_push_off'
        ? 'off'
        : error === 'mail_alert_unconfigured'
          ? 'unconfigured'
          : error === 'push_not_registered'
            ? 'not_registered'
            : 'refused';
    throw new MailAlertServerError(kind, res.status);
  };
  return {
    state: (deviceId, token) => post('/api/mls/mail-alert/state', { deviceId, token }),
    subscribe: (deviceId, token) => post('/api/mls/mail-alert/subscribe', { deviceId, token }),
    unsubscribe: (deviceId) => post('/api/mls/mail-alert/unsubscribe', { deviceId }),
  };
}
