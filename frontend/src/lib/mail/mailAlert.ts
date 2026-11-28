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
 * call - measured 2026-11-28): named for the ESTATE ({@link alertRuleName}: `canari-alerte` in
 * production, `canari-alerte-dev` on dev), LAST, matching every mail but delivery reports, whose
 * `actionNotify` sends a notice to `n-<128 random bits>@<the estate's alert domain>` and whose
 * `actionKeep` files the mail as usual. It subscribes itself with Canari's server under that token.
 * Cloudflare's Email Worker turns each notice into a post of the token alone, and the server into an
 * EMPTY push. The device then reads the mail itself.
 *
 * LAST, so a rule of the user's that ends with `stop` (a mail filed away, discarded) also ends ours:
 * a mail the user's filters put aside is not announced. The cost: a mail whose own rule stops before
 * ours is never pushed (documented in D11).
 *
 * THE NOTICE'S TEXT IS OURS: its subject is {@link ALERT_SUBJECT} and its body {@link ALERT_CONTENT},
 * with `maxBodySize: 0`. Measured on Partage (2026-11-28): the notice arrived in about a second, its
 * subject was exactly the fixed text, neither the original subject nor its body travelled, and its
 * sender was the account itself. So Cloudflare sees the account's address, a fixed text, the token
 * and when each notice arrives - never what the mail said or who sent it.
 *
 * ONLY THIS ESTATE'S RULE IS EVER TOUCHED (an allowlist, never a denylist): every write hands back
 * the other rules exactly as Zimbra read them, in their order - the other estate's rule among them -
 * and adds, replaces or removes only a rule that is ours by {@link isOurRule}: this estate's name AND
 * a notice to `n-<hex>@<this estate's domain>`. The write is GUARDED: the list is read again just
 * before it and must not have changed, and read again after it, which must show our rule once and
 * every other rule identical ({@link writeRules}).
 *
 * A rule of ours the user DISABLED in the webmail is an opt-out, respected: never re-enabled, and
 * this device's notifications switch is turned off.
 *
 * Every step is IDEMPOTENT and decided from durable facts - the rules Zimbra answers, the server's
 * state, the device's record - never from a clock: the controller calls {@link syncMailAlert}
 * whenever a fact changes and it converges.
 */

/** The notice's fixed subject: neutral, and the only text Cloudflare's servers see. */
export const ALERT_SUBJECT = 'Canari';
/** The notice's fixed body (Zimbra refuses a bare string: `content` is `[{ _content }]`). */
export const ALERT_CONTENT = 'Canari';

/**
 * The estate's rule name: `canari-` and the first label of its alert domain (`alerte.canari-emse.fr`
 * gives `canari-alerte`, `alerte-dev.canari-emse.fr` gives `canari-alerte-dev`). Production and dev
 * share the real mailbox, so each estate owns a rule of its own name and never reads the other's.
 */
export function alertRuleName(domain: string): string {
  return `canari-${domain.trim().toLowerCase().split('.')[0]}`;
}

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
 * The estate's rule notifying `address` on `domain`: every mail but a delivery report - an `allof`
 * of three NEGATED header tests (`Auto-Submitted` matching `auto-*`, `From` containing
 * `mailer-daemon` or `postmaster`; a header a mail lacks satisfies its negated test) - so a notice
 * that bounces never triggers another. Notifies with the fixed text and no body, then keeps the mail.
 * No `actionStop`.
 */
export function alertRule(address: string, domain: string): FilterRule {
  return {
    name: alertRuleName(domain),
    active: true,
    filterTests: [
      {
        condition: 'allof',
        headerTest: [
          {
            index: 0,
            header: 'auto-submitted',
            stringComparison: 'matches',
            value: 'auto-*',
            negative: true,
          },
          {
            index: 1,
            header: 'from',
            stringComparison: 'contains',
            value: 'mailer-daemon',
            negative: true,
          },
          {
            index: 2,
            header: 'from',
            stringComparison: 'contains',
            value: 'postmaster',
            negative: true,
          },
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

/** Whether `rule` is THIS estate's: its name AND a notice to `n-<hex>@<domain>`. */
export function isOurRule(rule: FilterRule, domain: string): boolean {
  const address = notifyAddressOf(rule);
  const parsed = address === null ? null : parseAlertAddress(address);
  return (
    rule.name === alertRuleName(domain) &&
    parsed !== null &&
    parsed.domain === domain.trim().toLowerCase()
  );
}

/** This estate's rule as the account holds it now. */
interface OurRule {
  token: string;
  active: boolean;
}

function ourRuleOf(rules: readonly FilterRule[], domain: string): OurRule | null {
  const rule = rules.find((r) => isOurRule(r, domain));
  if (!rule) return null;
  return {
    token: parseAlertAddress(notifyAddressOf(rule)!)!.token,
    active: rule.active === true || rule.active === '1',
  };
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
  /** The estate's alert domain, whatever the mode; `null` when the estate has none. */
  domain: string | null;
  deviceSubscribed: boolean;
  tokenLive: boolean;
  devices: number;
  /** The account holds a token: a rule of this estate's MAY exist. */
  accountToken: boolean;
}

/** A refusal of the server, TYPED from its `error` field - never from its prose. */
export class MailAlertServerError extends Error {
  constructor(
    readonly kind: 'off' | 'unconfigured' | 'not_registered' | 'token_taken' | 'refused',
    readonly status: number
  ) {
    super(`mail alert server refused: ${kind} (${status})`);
  }
}

/** The account's rule list changed between this device's read and its write: the sync starts over. */
export class MailAlertRulesChangedError extends Error {
  constructor() {
    super('the filter rules changed during the sync');
  }
}

/** The rule list read back after a write is not what was written: logged, never retried blindly. */
export class MailAlertRulesMismatchError extends Error {
  constructor(readonly what: 'ours' | 'others') {
    super(`the filter rules read back differ from the write (${what})`);
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
  /** The estate's rule now names a new token of this device. */
  | 'configured'
  /** The estate's rule already named the account's live token; this device joined it. */
  | 'joined'
  /** Nothing to do: already as wanted. */
  | 'unchanged'
  /** This device left; others still want the push (or the user disabled the rule), so it stays. */
  | 'left'
  /** This device was the last: the estate's rule is removed, every other rule untouched. */
  | 'removed'
  /** A rule of this estate's nobody listens to any more was removed. */
  | 'repaired'
  /** The user disabled the rule in the webmail: respected, and this device's switch turned off. */
  | 'opted_out'
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
  /** Turns this device's notifications switch off: the user disabled the rule (an opt-out). */
  onOptOut?: () => void;
}

/** How many times a sync starts over when the rule list changed under it. */
const MAX_SYNC_ATTEMPTS = 3;
/** How many tokens a configure draws when the server says one is taken (a collision). */
const MAX_TOKEN_DRAWS = 3;

async function readRules(mailbox: MailAlertDeps['mailbox']): Promise<FilterRule[]> {
  return parseFilterRules(await mailbox.call(getFilterRulesRequest()));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * THE GUARDED WRITE: the list is read again and must still be `before` (else
 * {@link MailAlertRulesChangedError}, and the sync starts over), then `before` is written back with
 * this estate's rule replaced by `ours` (put LAST) or removed (`null`), then read again: it must show
 * our rule exactly as many times as written and every other rule identical, in order (else
 * {@link MailAlertRulesMismatchError}). Returns how many other rules were kept.
 */
async function writeRules(
  mailbox: MailAlertDeps['mailbox'],
  before: readonly FilterRule[],
  domain: string,
  ours: FilterRule | null
): Promise<number> {
  const now = await readRules(mailbox);
  if (!same(now, before)) throw new MailAlertRulesChangedError();
  const others = before.filter((rule) => !isOurRule(rule, domain));
  await mailbox.call(modifyFilterRulesRequest(ours ? [...others, ours] : others));
  const after = await readRules(mailbox);
  const afterOurs = after.filter((rule) => isOurRule(rule, domain)).length;
  if (afterOurs !== (ours ? 1 : 0)) {
    Log.w('MAIL-ALERT', `ERROR: the rules read back hold ${afterOurs} rule(s) of ours`);
    throw new MailAlertRulesMismatchError('ours');
  }
  if (
    !same(
      after.filter((rule) => !isOurRule(rule, domain)),
      others
    )
  ) {
    Log.w(
      'MAIL-ALERT',
      `ERROR: the user's rules read back differ from the ${others.length} written`
    );
    throw new MailAlertRulesMismatchError('others');
  }
  return others.length;
}

/**
 * Brings the account's rule to what this device wants: `want` true installs this estate's rule (or
 * joins the token already there), false takes this device out and, when it was the last, removes the
 * rule. Idempotent; starts over (bounded) when the rule list changed under it; throws what the mailbox
 * or the server threw (the caller logs and retries on the next fact).
 */
export async function syncMailAlert(deps: MailAlertDeps, want: boolean): Promise<MailAlertOutcome> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await syncOnce(deps, want);
    } catch (err) {
      if (!(err instanceof MailAlertRulesChangedError) || attempt >= MAX_SYNC_ATTEMPTS) throw err;
      Log.i('MAIL-ALERT', `the rules changed under the sync - starting over (${attempt})`);
    }
  }
}

async function syncOnce(deps: MailAlertDeps, want: boolean): Promise<MailAlertOutcome> {
  const { userId, deviceId, server, store } = deps;
  if (!deviceId) {
    if (want) Log.i('MAIL-ALERT', 'no device id yet - the alert waits for one');
    return 'no_device';
  }
  const record = readAlertRecord(userId, store);
  const state = await server.state(deviceId, null);
  if (want) return ensureAlert(deps, deviceId, record, state);
  if (record?.subscribed) return releaseAlert(deps, deviceId, state);
  return repairOrphanAlert(deps, deviceId, record, state);
}

async function ensureAlert(
  deps: MailAlertDeps,
  deviceId: string,
  record: MailAlertRecord | null,
  first: MailAlertServerState
): Promise<MailAlertOutcome> {
  const { userId, mailbox, server, store } = deps;
  if (first.mode !== 'cloudflare') return 'off';
  const domain = first.domain;
  if (!domain) {
    Log.w('MAIL-ALERT', 'ERROR: the server has no alert domain - nothing configured');
    return 'unconfigured';
  }
  const rules = await readRules(mailbox);
  const current = ourRuleOf(rules, domain);
  if (current && !current.active) {
    // The user turned it off in the webmail: theirs to decide. Never re-enabled.
    if (record?.subscribed) await server.unsubscribe(deviceId);
    writeAlertRecord(userId, null, store);
    deps.onOptOut?.();
    Log.w('MAIL-ALERT', "the user disabled Canari's rule - respected, notifications turned off");
    return 'opted_out';
  }
  const state = current ? await server.state(deviceId, current.token) : first;
  if (current && state.tokenLive) {
    if (state.deviceSubscribed && record?.subscribed) return 'unchanged';
    await server.subscribe(deviceId, current.token);
    writeAlertRecord(userId, true, store);
    Log.i('MAIL-ALERT', `joined the account's live alert (devices=${state.devices + 1})`);
    return 'joined';
  }
  const { token, domain: given } = await subscribeNewToken(server, deviceId);
  writeAlertRecord(userId, true, store);
  let kept: number;
  try {
    kept = await writeRules(mailbox, rules, domain, alertRule(alertAddress(token, given), domain));
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

/** Subscribes under a fresh token, drawing again (bounded) when the server says one is taken. */
async function subscribeNewToken(
  server: MailAlertServer,
  deviceId: string
): Promise<{ token: string; domain: string }> {
  for (let draw = 1; ; draw++) {
    const token = newAlertToken();
    try {
      const { domain } = await server.subscribe(deviceId, token);
      return { token, domain };
    } catch (err) {
      if (!(err instanceof MailAlertServerError) || err.kind !== 'token_taken') throw err;
      if (draw >= MAX_TOKEN_DRAWS) throw err;
      Log.w('MAIL-ALERT', `a drawn token was taken - drawing again (${draw})`);
    }
  }
}

/**
 * This device leaves: unsubscribed first, then this estate's rule removed when the SERVER says
 * nobody listens any more (and the user has not disabled it). The sign-out paths reach it while
 * the mailbox session is still open ({@link releaseMailAlertBeforeSignOut}).
 */
async function releaseAlert(
  deps: MailAlertDeps,
  deviceId: string,
  first: MailAlertServerState
): Promise<MailAlertOutcome> {
  const { userId, mailbox, server, store } = deps;
  await server.unsubscribe(deviceId);
  writeAlertRecord(userId, false, store);
  const domain = first.domain;
  if (!domain) {
    writeAlertRecord(userId, null, store);
    Log.w('MAIL-ALERT', 'ERROR: no alert domain - the rule cannot be named, left in place');
    return 'left';
  }
  const rules = await readRules(mailbox);
  const current = ourRuleOf(rules, domain);
  if (!current) {
    writeAlertRecord(userId, null, store);
    Log.i('MAIL-ALERT', 'the account holds no rule of this estate - nothing to remove');
    return 'unchanged';
  }
  // Whether another device still listens is the SERVER's fact, read after this device left.
  const state = await server.state(deviceId, current.token);
  if ((state.mode === 'cloudflare' && state.tokenLive) || !current.active) {
    writeAlertRecord(userId, null, store);
    Log.i(
      'MAIL-ALERT',
      `this device left the alert; ${state.devices} device(s) still listen, rule active=${current.active}`
    );
    return 'left';
  }
  await writeRules(mailbox, rules, domain, null);
  writeAlertRecord(userId, null, store);
  Log.i('MAIL-ALERT', "the last device left: this estate's rule is removed");
  return 'removed';
}

/**
 * A device that holds no subscription and does not want the push: if a rule of this estate's MAY
 * exist (the account holds a token, or this device kept a record) and the server says nobody listens
 * to it (or the switch is `none`), it is REMOVED - a destructive repair gated on knowing the state is
 * broken, touching only our own rule. Otherwise the account's rules are not even read.
 */
async function repairOrphanAlert(
  deps: MailAlertDeps,
  deviceId: string,
  record: MailAlertRecord | null,
  first: MailAlertServerState
): Promise<MailAlertOutcome> {
  const { userId, mailbox, server, store } = deps;
  const domain = first.domain;
  if (!domain || (!first.accountToken && record === null)) return 'unchanged';
  const rules = await readRules(mailbox);
  const current = ourRuleOf(rules, domain);
  if (!current) {
    writeAlertRecord(userId, null, store);
    return 'unchanged';
  }
  const state = await server.state(deviceId, current.token);
  if ((state.mode === 'cloudflare' && state.tokenLive) || !current.active) return 'unchanged';
  await writeRules(mailbox, rules, domain, null);
  writeAlertRecord(userId, null, store);
  Log.w(
    'MAIL-ALERT',
    `a rule of this estate's nobody listens to was removed (mode=${state.mode} live=${state.tokenLive})`
  );
  return 'repaired';
}

/**
 * THE SIGN-OUT HALF: takes this device out and removes the estate's rule when it was the last, WHILE
 * THE MAILBOX SESSION IS STILL OPEN - called by the mail sign-out and by Canari's logout / "forget
 * mail" before they end the session. A no-op when this device never subscribed. Never throws: a
 * failure is logged, and the rule is then left to the orphan repair of another device (or outlives
 * Canari - register C34).
 */
export async function releaseMailAlertBeforeSignOut(deps: MailAlertDeps): Promise<void> {
  if (!readAlertRecord(deps.userId, deps.store)?.subscribed) return;
  try {
    const outcome = await syncMailAlert(deps, false);
    Log.i('MAIL-ALERT', `released before the sign-out: ${outcome}`);
  } catch (err) {
    Log.w('MAIL-ALERT', `ERROR: the alert was not released before the sign-out (${String(err)})`);
  }
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
    const kinds: Record<string, MailAlertServerError['kind']> = {
      mail_push_off: 'off',
      mail_alert_unconfigured: 'unconfigured',
      push_not_registered: 'not_registered',
      mail_alert_token_taken: 'token_taken',
    };
    throw new MailAlertServerError(
      (typeof error === 'string' ? kinds[error] : undefined) ?? 'refused',
      res.status
    );
  };
  return {
    state: (deviceId, token) => post('/api/mls/mail-alert/state', { deviceId, token }),
    subscribe: (deviceId, token) => post('/api/mls/mail-alert/subscribe', { deviceId, token }),
    unsubscribe: (deviceId) => post('/api/mls/mail-alert/unsubscribe', { deviceId }),
  };
}
