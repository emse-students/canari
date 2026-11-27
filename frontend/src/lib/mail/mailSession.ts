import { Log } from '$lib/utils/Log';
import { isMailEligibleAddress } from './eligibility';
import { classifyMailFailure, MailError } from './mailErrors';
import { eraseMailLocalData } from './mailLocalData';
import type { MailAccount } from './mailTypes';
import {
  forgetMailPassword,
  readRememberedMailPassword,
  rememberMailPassword,
} from './sealedMailPassword';
import type { HttpRequest, HttpResponse } from './http1';
import type { ZimbraSoapClient } from './soapClient';
import { parseAuth, parseInfo } from './zimbraParse';
import { authRequest, endSessionRequest, getInfoRequest } from './zimbraRequests';

/**
 * THE SESSION WITH THE SCHOOL MAILBOX (docs/wiki/mail-client.md D6, D7, D8).
 *
 * The Zimbra token lives in THIS object's memory and nowhere else. It lasts about two days
 * (measured), but nothing here reads that lifetime: the session is renewed when the server ANSWERS
 * that it ended (`service.AUTH_EXPIRED` / `service.AUTH_REQUIRED`), never on a clock. The renewal
 * uses the password sealed under the device key when the user asked to remember it; otherwise the
 * session asks for the password again ({@link MailSessionState} `needs_password`).
 *
 * EVERY CALL GOES THROUGH {@link MailSession.call} or {@link MailSession.http}, the one seam where
 * a failure is classified ({@link classifyMailFailure}) and where its consequences are decided:
 *
 * - session ended -> ONE renewal, shared by every call that saw the same token end, then the call
 *   is sent ONCE more. A fault is an answer: the server refused the call before carrying it out, so
 *   sending it again cannot do it twice (unlike a connection lost mid-call, which is never re-sent).
 * - account closed -> D8: the mail data on this device is erased (an allowlist) and the state says
 *   so.
 * - a remembered password the server refuses -> forgotten at once, and asked for: a stale password
 *   replayed at every renewal would lock the account.
 */

/**
 * What the mail session reads from the signed-in Canari account: its id, its device key, and its
 * own school address. Lot 3 wires it to the Canari session; a test stubs it.
 */
export interface MailContext {
  /** The Canari account id: the remembered password is kept per Canari account. */
  readonly userId: string;
  /** The device key (base64), or `null` while the Canari session is locked. */
  deviceKey(): string | null;
  /**
   * The account's own address from its MiConnect identity, read client-side (owner, 2026-11-27:
   * the sign-in asks ONLY the password - the address is never typed). `null` when the identity
   * carries none.
   */
  mailAddress(): Promise<string | null>;
}

/** D1 as the session answers it before and after a sign-in. */
export type MailEligibility = 'unknown' | 'eligible' | 'not_eligible';

/** Why the password is asked for. */
export type PasswordAskReason =
  /** The session ended and the password was not remembered. */
  | 'not_remembered'
  /** The remembered password was refused by the server (changed at the school): it is forgotten. */
  | 'password_refused'
  /** A password is remembered but this device key does not open it. */
  | 'remembered_unopenable'
  /** A password is remembered but the Canari session is locked (no device key right now). */
  | 'device_locked';

/** Where the mail session stands - what the screens render. */
export type MailSessionState =
  /** No mailbox session, and nothing remembered. */
  | { kind: 'signed_out' }
  /** The password is needed to (re)open the mailbox `account` (`null` when it is not known). */
  | { kind: 'needs_password'; account: string | null; reason: PasswordAskReason }
  /** Signed in. */
  | { kind: 'ready'; account: MailAccount; remembered: boolean }
  /** The school closed the account (D8): its mail data was erased from this device. */
  | { kind: 'closed'; account: string | null };

/** The part of `ZimbraSoapClient` the session uses (a test double needs only these). */
export type MailSoap = Pick<ZimbraSoapClient, 'call' | 'exchange' | 'close'>;

/** Reads one HTTP answer of the session (an upload, a download), or throws it typed. */
export type HttpAnswerReader<T> = (response: HttpResponse) => T;

export class MailSession {
  private token: string | null = null;
  /** The address the token was obtained for: the renewal signs in to that one, never another. */
  private authName: string | null = null;
  private renewing: Promise<void> | null = null;
  private current: MailSessionState = { kind: 'signed_out' };
  private readonly listeners = new Set<(state: MailSessionState) => void>();

  constructor(
    private readonly soap: MailSoap,
    private readonly context: MailContext,
    private readonly store: Storage = localStorage
  ) {}

  /** The current state. */
  get state(): MailSessionState {
    return this.current;
  }

  /** Calls `listener` at every state change; returns the unsubscribe. */
  onState(listener: (state: MailSessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(state: MailSessionState): void {
    Log.d('MAIL', `session state: ${state.kind}`);
    this.current = state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        Log.w('MAIL', 'ERROR: a mail session state listener threw', err);
      }
    }
  }

  /**
   * D1 for the signed-in Canari account, from its own address ({@link MailContext.mailAddress}):
   * `unknown` when the identity carries none. What the tab is shown on, before any mail sign-in.
   */
  async eligibility(): Promise<MailEligibility> {
    const address = await this.context.mailAddress();
    const verdict: MailEligibility =
      address === null ? 'unknown' : isMailEligibleAddress(address) ? 'eligible' : 'not_eligible';
    Log.d('MAIL', `eligibility from the account's own address: ${verdict}`);
    return verdict;
  }

  /**
   * Signs in to the account's OWN mailbox - its address comes from {@link MailContext.mailAddress},
   * never from what a user typed - with `password`, and remembers the password sealed under the
   * device key when `remember` is set (forgets any remembered one otherwise). An address off the
   * eligible domains is refused before a byte is sent (D1).
   *
   * @throws {MailError} `address_unknown`, `not_eligible`, `bad_credentials`, `account_closed`, ...
   */
  async signIn(password: string, remember: boolean): Promise<MailAccount> {
    Log.d('MAIL', `sign-in requested (remember: ${remember})`);
    const address = await this.context.mailAddress();
    if (address === null) {
      Log.w('MAIL', 'sign-in refused: the account identity carries no address');
      throw new MailError('address_unknown', 'no-identity-address');
    }
    const name = address.trim().toLowerCase();
    if (!isMailEligibleAddress(name)) {
      Log.d('MAIL', 'sign-in refused: the address is not on an eligible domain');
      throw new MailError('not_eligible', 'domain');
    }
    const account = await this.authenticate(name, password);
    if (remember) {
      const key = this.context.deviceKey();
      if (key) {
        await rememberMailPassword(
          this.context.userId,
          key,
          { account: name, password },
          this.store
        );
      } else {
        Log.w(
          'MAIL',
          'ERROR: remember was asked while the device key is not held - not remembered'
        );
        remember = false;
      }
    } else {
      forgetMailPassword(this.context.userId, this.store);
    }
    this.setState({ kind: 'ready', account, remembered: remember });
    return account;
  }

  /**
   * Opens the mailbox from the remembered password, when there is one. Resolves `true` when signed
   * in; `false` when the state now says what is missing (nothing remembered, the device locked, the
   * password refused).
   */
  async resume(): Promise<boolean> {
    Log.d('MAIL', `resume requested (state ${this.current.kind})`);
    if (this.current.kind === 'ready') return true;
    // A closed mailbox stays closed: what it kept is erased, and only a new sign-in reopens one.
    if (this.current.kind === 'closed') return false;
    try {
      await this.renewFromRemembered();
      return true;
    } catch (err) {
      const failure = classifyMailFailure(err);
      if (failure.kind === 'session_expired') return false;
      throw failure;
    }
  }

  /**
   * One SOAP call with the session's token, renewed once if the server says it ended.
   *
   * @throws {MailError} typed; `not_signed_in` with no session.
   */
  async call(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withToken((token) => this.soap.call(body, token));
  }

  /**
   * One plain HTTP exchange carrying the session as Zimbra's `ZM_AUTH_TOKEN` cookie (the upload
   * servlet, an attachment download), read by `read`, renewed once like {@link call}.
   */
  async http<T>(build: (token: string) => HttpRequest, read: HttpAnswerReader<T>): Promise<T> {
    return this.withToken(async (token) => read(await this.soap.exchange(build(token))));
  }

  /**
   * Signs out: the token is dropped and the remembered password forgotten BEFORE the first await (a
   * renewal must find nothing to renew with), then the server is told, then the connection closed.
   */
  async signOut(): Promise<void> {
    Log.d('MAIL', 'sign-out requested');
    const token = this.token;
    this.token = null;
    this.authName = null;
    forgetMailPassword(this.context.userId, this.store);
    this.setState({ kind: 'signed_out' });
    if (token) {
      try {
        await this.soap.call(endSessionRequest(), token);
      } catch (err) {
        // The token is gone from this device either way; it lapses on the server by itself.
        Log.w('MAIL', 'the server was not told of the sign-out', classifyMailFailure(err));
      }
    }
    this.soap.close();
  }

  /** `AuthRequest` then `GetInfoRequest`: the token, and the canonical account, eligible (D1). */
  private async authenticate(name: string, password: string): Promise<MailAccount> {
    let token: string;
    try {
      token = parseAuth(await this.soap.call(authRequest(name, password))).token;
    } catch (err) {
      throw this.settle(classifyMailFailure(err), name);
    }
    let account: MailAccount;
    try {
      account = parseInfo(await this.soap.call(getInfoRequest(), token));
    } catch (err) {
      throw this.settle(classifyMailFailure(err), name);
    }
    if (!isMailEligibleAddress(account.address)) {
      Log.w('MAIL', 'sign-in refused: the canonical address is not on an eligible domain');
      try {
        await this.soap.call(endSessionRequest(), token);
      } catch (err) {
        Log.w('MAIL', 'the refused session was not ended on the server', classifyMailFailure(err));
      }
      throw new MailError('not_eligible', 'canonical-domain');
    }
    this.token = token;
    this.authName = name;
    Log.d('MAIL', 'signed in');
    return account;
  }

  /** Runs `op` with the token; on a session-ended answer, renews ONCE and runs it ONCE more. */
  private async withToken<T>(op: (token: string) => Promise<T>): Promise<T> {
    if (this.renewing) await this.renewing.catch(() => undefined);
    const token = this.token;
    if (!token) throw new MailError('not_signed_in', 'no-token');
    try {
      return await op(token);
    } catch (err) {
      const failure = classifyMailFailure(err);
      if (failure.kind !== 'session_expired') throw this.settle(failure, this.authName);
      Log.d('MAIL', `the session ended (${failure.code}) - renewing it`);
      try {
        await this.renew(token);
      } catch (renewal) {
        const refused = classifyMailFailure(renewal);
        // The call did not fail for its own reason: what it owes its caller is "the session ended";
        // the state says why (the password refused, the device locked, nothing remembered).
        throw refused.kind === 'bad_credentials' || refused.kind === 'password_change_required'
          ? new MailError('session_expired', refused.code, refused)
          : refused;
      }
      const renewed = this.token;
      if (!renewed) throw new MailError('session_expired', 'renewal-left-no-token');
      try {
        return await op(renewed);
      } catch (again) {
        const second = classifyMailFailure(again);
        if (second.kind === 'session_expired') {
          Log.w('MAIL', 'ERROR: a freshly renewed session was refused - the password is asked');
          this.dropToken('not_remembered', this.authName);
        }
        throw this.settle(second, this.authName);
      }
    }
  }

  /**
   * Renews the session whose token `stale` ended - ONCE for every call that saw it end: a call that
   * finds a newer token already in place uses it, and calls that fail together share one renewal.
   * The stale token is KEPT while the renewal runs and after a renewal the network failed: the next
   * call is then refused by the server again and renews again - driven by that answer, never a timer.
   * A renewal that cannot succeed (nothing remembered, the password refused) drops it.
   */
  private renew(stale: string): Promise<void> {
    if (this.token !== null && this.token !== stale) return Promise.resolve();
    if (!this.renewing) {
      this.renewing = this.renewFromRemembered().finally(() => {
        this.renewing = null;
      });
    }
    return this.renewing;
  }

  /** Signs in again from the remembered password, or sets the state that asks for it. */
  private async renewFromRemembered(): Promise<void> {
    const account =
      this.current.kind === 'ready'
        ? this.current.account.address
        : this.current.kind === 'needs_password'
          ? this.current.account
          : this.authName;
    const key = this.context.deviceKey();
    if (!key) {
      this.dropToken('device_locked', account);
      throw new MailError('session_expired', 'device-locked');
    }
    const read = await readRememberedMailPassword(this.context.userId, key, this.store);
    if (read.kind === 'none') {
      if (this.authName === null && this.current.kind === 'signed_out') {
        Log.d('MAIL', 'nothing is remembered: the mailbox stays signed out');
      } else {
        this.dropToken('not_remembered', account);
      }
      throw new MailError('session_expired', 'not-remembered');
    }
    if (read.kind === 'unopenable') {
      this.dropToken('remembered_unopenable', account);
      throw new MailError('session_expired', 'remembered-unopenable');
    }
    const { remembered } = read;
    if (this.authName !== null && remembered.account !== this.authName) {
      Log.w('MAIL', 'ERROR: the remembered password is for another mailbox - not used');
      this.dropToken('not_remembered', account);
      throw new MailError('session_expired', 'remembered-other-account');
    }
    try {
      const signedIn = await this.authenticate(remembered.account, remembered.password);
      this.setState({ kind: 'ready', account: signedIn, remembered: true });
      Log.d('MAIL', 'the session was renewed from the remembered password');
    } catch (err) {
      const failure = classifyMailFailure(err);
      if (failure.kind === 'bad_credentials' || failure.kind === 'password_change_required') {
        Log.i('MAIL', `the remembered password was refused (${failure.code}) - it is forgotten`);
        forgetMailPassword(this.context.userId, this.store);
        this.dropToken('password_refused', remembered.account);
      }
      throw failure;
    }
  }

  /** The session is over with nothing to renew it now: the password is asked for `account`. */
  private dropToken(reason: PasswordAskReason, account: string | null): void {
    this.token = null;
    this.setState({ kind: 'needs_password', account, reason });
  }

  /** What a classified failure does to the session (D8 for a closed account), returned to throw. */
  private settle(failure: MailError, account: string | null): MailError {
    if (failure.kind === 'account_closed') {
      Log.i('MAIL', `the mailbox answered ${failure.code}: the account is closed (D8)`);
      this.token = null;
      this.authName = null;
      eraseMailLocalData(this.context.userId, this.store);
      this.soap.close();
      this.setState({ kind: 'closed', account });
    }
    return failure;
  }
}
