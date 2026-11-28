import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { Log } from '$lib/utils/Log';
import type { MailCaller } from './mailApi';
import { parseFilterRules } from './zimbraParse';
import { getFilterRulesRequest, modifyFilterRulesRequest } from './zimbraRequests';

/**
 * ONE FILTER RULE OF THE ACCOUNT'S, NOTIFYING AN OPAQUE ADDRESS - MAIL LOT 5'S CLIENT HALF
 * (docs/wiki/mail-client-transport.md#as-built---lot-5; D11 as revised, owner 2026-11-28).
 *
 * While `mail_push = cloudflare` and the account wants notifications on a phone, the device adds
 * ONE incoming filter rule to the account (`ModifyFilterRulesRequest`, which Partage lets a user
 * call - measured 2026-11-28): named {@link ALERT_RULE_NAME}, FIRST, matching every mail, whose
 * `actionNotify` sends a notice to `n-<128 random bits>@<the estate's alert domain>` and whose
 * `actionKeep` files the mail as usual. It subscribes itself with Canari's server under that token.
 * Cloudflare's Email Worker turns each notice into a post of the token alone, and the server into an
 * EMPTY push. The device then reads the mail itself.
 *
 * THE NOTICE'S TEXT IS OURS: its subject is {@link ALERT_SUBJECT} and its body {@link ALERT_CONTENT},
 * with `maxBodySize: 0`. Measured on Partage (2026-11-28): the notice arrived in about a second, its
 * subject was exactly the fixed text, neither the original subject nor its body travelled, and its
 * sender was the account itself. So Cloudflare sees the account's address, a fixed text and the
 * token - never what the mail said or who sent it.
 *
 * ONLY OUR OWN RULE IS EVER TOUCHED (an allowlist, never a denylist): every write hands back the
 * other rules exactly as Zimbra read them, in their order, and adds, replaces or removes only a rule
 * that is ours by {@link isAlertRule} - our name AND a notice to an address of Canari's shape. No
 * `actionStop`: the user's own rules run after ours as before.
 *
 * Every step is IDEMPOTENT and decided from durable facts - the rules Zimbra answers, the server's
 * state, the device's record - never from a clock: the controller calls {@link syncMailAlert}
 * whenever a fact changes and it converges.
 */

/** The name of Canari's rule, recognisable in the webmail's filter list. */
export const ALERT_RULE_NAME = 'canari-alerte';
/** The notice's fixed subject: neutral, and the only text Cloudflare's servers see. */
export const ALERT_SUBJECT = 'Canari';
/** The notice's fixed body (Zimbra refuses a bare string: `content` is `[{ _content }]`). */
export const ALERT_CONTENT = 'Canari';

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

/** One filter rule as Zimbra's JSON carries it - kept opaque, so the user's go back verbatim. */
export type FilterRule = Record<string, unknown>;

/**
 * Canari's rule notifying `address`: matches every mail (an `anyof` of a `From` or a `Received`
 * header, in the header-test shape measured on Partage - every delivered mail carries one), notifies
 * with the fixed text and no body, then keeps the mail. No `actionStop`.
 */
export function alertRule(address: string): FilterRule {
  return {
    name: ALERT_RULE_NAME,
    active: true,
    filterTests: [
      {
        condition: 'anyof',
        headerTest: [
          { index: 0, header: 'from', stringComparison: 'matches', value: '*' },
          { index: 1, header: 'received', stringComparison: 'matches', value: '*' },
        ],
      },
    ],
    filterActions: [
      {
        actionNotify: [
          {
            index: 0,
            a: address,
            su: ALERT_SUBJECT,
            content: [{ _content: ALERT_CONTENT }],
            maxBodySize: 0,
          },
        ],
        actionKeep: [{ index: 1 }],
      },
    ],
  };
}

/** Zimbra sends one element as an object or as a one-element array: always the array. */
function many(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
  }
  return value && typeof value === 'object' ? [value as Record<string, unknown>] : [];
}

/** The address the rule's first `actionNotify` names, or `null`. */
function notifyAddressOf(rule: FilterRule): string | null {
  const notify = many(rule.filterActions).flatMap((actions) => many(actions.actionNotify))[0];
  return typeof notify?.a === 'string' ? notify.a : null;
}

/** Whether `rule` is Canari's: our name AND a notice to an address of Canari's shape. */
export function isAlertRule(rule: FilterRule): boolean {
  const address = notifyAddressOf(rule);
  return rule.name === ALERT_RULE_NAME && address !== null && parseAlertAddress(address) !== null;
}

/** Canari's rule as the account holds it now. */
interface CurrentAlert {
  token: string;
  domain: string;
  active: boolean;
}

function currentAlertOf(rules: readonly FilterRule[]): CurrentAlert | null {
  for (const rule of rules) {
    const address = rule.name === ALERT_RULE_NAME ? notifyAddressOf(rule) : null;
    const parsed = address === null ? null : parseAlertAddress(address);
    if (parsed) return { ...parsed, active: rule.active === true || rule.active === '1' };
  }
  return null;
}

/** What this device keeps (`ACCOUNT_KEY.mailAlert`, one of the D8 keys). */
export interface MailAlertRecord {
  v: 1;
  /** Whether this device subscribed with the server. */
  subscribed: boolean;
}

/** The record of `userId`, or `null` (none, or unreadable - logged). */
export function readAlertRecord(userId: string, store: Storage): MailAlertRecord | null {
  try {
    const raw = store.getItem(ACCOUNT_KEY.mailAlert(userId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<MailAlertRecord>;
    if (parsed.v !== 1 || typeof parsed.subscribed !== 'boolean') {
      Log.w('MAIL-ALERT', 'ERROR: the alert record is not one this build wrote - ignored');
      return null;
    }
    return { v: 1, subscribed: parsed.subscribed };
  } catch (err) {
    Log.w('MAIL-ALERT', `ERROR: the alert record could not be read (${String(err)})`);
    return null;
  }
}

/** Writes the record (`null` removes it). */
function writeAlertRecord(userId: string, subscribed: boolean | null, store: Storage): void {
  if (subscribed === null) store.removeItem(ACCOUNT_KEY.mailAlert(userId));
  else store.setItem(ACCOUNT_KEY.mailAlert(userId), JSON.stringify({ v: 1, subscribed }));
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
  /** Canari's rule now names a new token of this device. */
  | 'configured'
  /** Canari's rule already named the account's live token; this device joined it. */
  | 'joined'
  /** Nothing to do: already as wanted. */
  | 'unchanged'
  /** This device left; others still want the push, so the rule stays. */
  | 'left'
  /** This device was the last: Canari's rule is removed, the user's own rules untouched. */
  | 'removed'
  /** A rule of Canari's nobody listens to any more was removed. */
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

async function readRules(mailbox: MailAlertDeps['mailbox']): Promise<FilterRule[]> {
  return parseFilterRules(await mailbox.call(getFilterRulesRequest()));
}

/**
 * Writes the account's rules back with Canari's replaced by `ours` (put FIRST) or removed (`null`):
 * every other rule goes back exactly as read, in its order.
 */
async function writeOurRule(
  mailbox: MailAlertDeps['mailbox'],
  rules: readonly FilterRule[],
  ours: FilterRule | null
): Promise<number> {
  const others = rules.filter((rule) => !isAlertRule(rule));
  await mailbox.call(modifyFilterRulesRequest(ours ? [ours, ...others] : others));
  return others.length;
}

/**
 * Brings the account's rule to what this device wants: `want` true installs Canari's rule (or joins
 * the token already there), false takes this device out and, when it was the last, removes the rule.
 * Idempotent; throws what the mailbox or the server threw (the caller logs and retries on the next
 * fact).
 */
export async function syncMailAlert(deps: MailAlertDeps, want: boolean): Promise<MailAlertOutcome> {
  const record = readAlertRecord(deps.userId, deps.store);
  if (want) return ensureAlert(deps, record);
  if (record?.subscribed) return releaseAlert(deps);
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
  const rules = await readRules(mailbox);
  const current = currentAlertOf(rules);
  const state = await server.state(deviceId, current?.token ?? null);
  if (state.mode !== 'cloudflare') return 'off';
  if (!state.domain) {
    Log.w('MAIL-ALERT', 'ERROR: the server has no alert domain - nothing configured');
    return 'unconfigured';
  }
  if (current?.active && state.tokenLive && current.domain === state.domain) {
    if (state.deviceSubscribed && record?.subscribed) return 'unchanged';
    await server.subscribe(deviceId, current.token);
    writeAlertRecord(userId, true, store);
    Log.i('MAIL-ALERT', `joined the account's live alert (devices=${state.devices + 1})`);
    return 'joined';
  }
  const token = newAlertToken();
  const { domain } = await server.subscribe(deviceId, token);
  writeAlertRecord(userId, true, store);
  let kept: number;
  try {
    kept = await writeOurRule(mailbox, rules, alertRule(alertAddress(token, domain)));
  } catch (err) {
    Log.w('MAIL-ALERT', 'ERROR: the rule was not written - the subscription is taken back');
    await server
      .unsubscribe(deviceId)
      .then(() => writeAlertRecord(userId, false, store))
      .catch((e: unknown) => Log.w('MAIL-ALERT', `ERROR: the subscription stays (${String(e)})`));
    throw err;
  }
  Log.i(
    'MAIL-ALERT',
    `the rule now names this device's token (replaced: ${current !== null}, other rules kept: ${kept})`
  );
  return 'configured';
}

async function releaseAlert(deps: MailAlertDeps): Promise<MailAlertOutcome> {
  const { userId, deviceId, mailbox, server, store } = deps;
  if (!deviceId) {
    Log.w('MAIL-ALERT', 'ERROR: a record with no device id - left for the next fact');
    return 'no_device';
  }
  await server.unsubscribe(deviceId);
  writeAlertRecord(userId, false, store);
  const rules = await readRules(mailbox);
  const current = currentAlertOf(rules);
  if (!current) {
    writeAlertRecord(userId, null, store);
    Log.i('MAIL-ALERT', 'the account holds no rule of Canari - nothing to remove');
    return 'unchanged';
  }
  // Whether another device still listens is the SERVER's fact, read after this device left.
  const state = await server.state(deviceId, current.token);
  if (state.mode === 'cloudflare' && state.tokenLive) {
    writeAlertRecord(userId, null, store);
    Log.i('MAIL-ALERT', `this device left the alert; ${state.devices} device(s) still listen`);
    return 'left';
  }
  await writeOurRule(mailbox, rules, null);
  writeAlertRecord(userId, null, store);
  Log.i('MAIL-ALERT', "the last device left: Canari's rule is removed");
  return 'removed';
}

/**
 * A device that holds no subscription and does not want the push: if the account still holds a rule
 * of Canari's and the server says nobody listens to it (or the switch is `none`), the rule is
 * REMOVED - a destructive repair gated on knowing the state is broken, touching only our own rule.
 */
async function repairOrphanAlert(deps: MailAlertDeps): Promise<MailAlertOutcome> {
  const { userId, deviceId, mailbox, server, store } = deps;
  if (!deviceId) return 'no_device';
  const rules = await readRules(mailbox);
  const current = currentAlertOf(rules);
  if (!current) {
    writeAlertRecord(userId, null, store);
    return 'unchanged';
  }
  const state = await server.state(deviceId, current.token);
  if (state.mode === 'cloudflare' && state.tokenLive) return 'unchanged';
  await writeOurRule(mailbox, rules, null);
  writeAlertRecord(userId, null, store);
  Log.w(
    'MAIL-ALERT',
    `a rule of Canari's nobody listens to was removed (mode=${state.mode} live=${state.tokenLive})`
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
