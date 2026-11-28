import { Log } from '$lib/utils/Log';
import { mailClassOf } from './eligibility';
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
 * - account gone (`account.NO_SUCH_ACCOUNT` answered to the session's OWN sign-in, never another
 *   call) -> D8: the mail data on this device is erased (an allowlist) and the state says so. An
 *   inactive account (`account.ACCOUNT_INACTIVE`, which also means locked or pending) erases
 *   NOTHING: state `unavailable`.
 * - a remembered password the server refuses -> forgotten at once, and asked for: a stale password
 *   replayed at every renewal would lock the account.
 *
 * AN EPOCH ORDERS THE SESSION'S LIFE AGAINST ITS AWAITS. A sign-out, a closed account and a new
 * sign-in each bump it; a sign-in or a renewal captures it and re-checks it after EVERY await
 * before it installs a token, sets a state or stores a password. A sign-out that lands while an
 * `AuthRequest` is in flight therefore ends the token that request brings back instead of installing
 * it, and a password whose sealed write waited behind the device-key gate is not written back after
 * the sign-out forgot it.
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
  /** A password was remembered but this device key did not open it: it is removed. */
  | 'remembered_unopenable'
  /** A password is remembered but the Canari session is locked (no device key right now). */
  | 'device_locked'
  /** A session renewed a moment ago was refused at once: the server does not take it. */
  | 'session_refused';

/** Where the mail session stands - what the screens render. */
export type MailSessionState =
  /** No mailbox session, and nothing remembered. */
  | { kind: 'signed_out' }
  /** The password is needed to (re)open the mailbox `account` (`null` when it is not known). */
  | { kind: 'needs_password'; account: string | null; reason: PasswordAskReason }
  /** Signed in. */
  | { kind: 'ready'; account: MailAccount; remembered: boolean }
  /** The account is inactive (locked, pending, possibly closed): nothing was erased. */
  | { kind: 'unavailable'; account: string | null }
  /** The account no longer exists (D8): its mail data was erased from this device. */
  | { kind: 'closed'; account: string | null };

/** The part of `ZimbraSoapClient` the session uses (a test double needs only these). */
export type MailSoap = Pick<ZimbraSoapClient, 'call' | 'exchange' | 'close'>;

/** Reads one HTTP answer of the session (an upload, a download), or throws it typed. */
export type HttpAnswerReader<T> = (response: HttpResponse) => T;

/** The error an operation overtaken by a sign-out, a closed account or a newer sign-in ends with. */
function superseded(): MailError {
  return new MailError('not_signed_in', 'superseded');
}

/** The address as Zimbra names it. */
function normalized(address: string): string {
  return address.trim().toLowerCase();
}

export class MailSession {
  private token: string | null = null;
  /** The address the token was obtained for: the renewal signs in to that one, never another. */
  private authName: string | null = null;
  private renewing: Promise<void> | null = null;
  /** Bumped by a sign-out, a closed account and a new sign-in (see the module comment). */
  private epoch = 0;
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

  /**
   * The session's generation: it moves at every sign-out, closed account and new sign-in. A reader
   * that captured it compares before acting on what it read (the new-mail watcher writes its cursor
   * and notifies only while it is unchanged, mail lot 4).
   */
  get generation(): number {
    return this.epoch;
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
      address === null ? 'unknown' : mailClassOf(address) !== null ? 'eligible' : 'not_eligible';
    Log.d('MAIL', `eligibility from the account's own address: ${verdict}`);
    return verdict;
  }

  /**
   * Signs in to the account's OWN mailbox - its address comes from {@link MailContext.mailAddress},
   * never from what a user typed - with `password`, and remembers the password sealed under the
   * device key when `remember` is set (forgets any remembered one otherwise). An address off the
   * eligible domains is refused before a byte is sent (D1). A session already open is ended on the
   * server once the new one is in place.
   *
   * @throws {MailError} `address_unknown`, `not_eligible`, `bad_credentials`, `not_signed_in` (a
   * sign-out overtook it), ...
   */
  async signIn(password: string, remember: boolean): Promise<MailAccount> {
    const epoch = ++this.epoch;
    Log.d('MAIL', `sign-in requested (remember: ${remember})`);
    const address = await this.context.mailAddress();
    if (epoch !== this.epoch) throw superseded();
    if (address === null) {
      Log.w('MAIL', 'sign-in refused: the account identity carries no address');
      throw new MailError('address_unknown', 'no-identity-address');
    }
    const name = normalized(address);
    if (mailClassOf(name) === null) {
      Log.d('MAIL', 'sign-in refused: the address is not on an eligible domain');
      throw new MailError('not_eligible', 'domain');
    }
    const { token, account } = await this.authenticate(name, password, epoch);
    let remembered = false;
    if (remember) {
      const key = this.context.deviceKey();
      if (!key) {
        Log.w('MAIL', 'remember was asked while the device key is not held - not remembered');
      } else {
        try {
          remembered = await rememberMailPassword(
            this.context.userId,
            key,
            { account: name, password },
            this.store,
            () => epoch === this.epoch
          );
        } catch (err) {
          Log.w('MAIL', 'the password could not be remembered - signed in without it', err);
        }
      }
      if (epoch !== this.epoch) {
        await this.endQuietly(token);
        throw superseded();
      }
    } else {
      forgetMailPassword(this.context.userId, this.store);
    }
    const previous = this.token;
    this.token = token;
    this.authName = name;
    this.setState({ kind: 'ready', account, remembered });
    if (previous && previous !== token) {
      Log.d('MAIL', 'the session this sign-in replaced is ended on the server');
      void this.endQuietly(previous);
    }
    return account;
  }

  /**
   * Opens the mailbox from the remembered password, when there is one - through the SAME renewal a
   * lapsed call would start, so the two never sign in twice. Resolves `true` when signed in; `false`
   * when the state now says what is missing (nothing remembered, the device locked, the password
   * refused).
   */
  async resume(): Promise<boolean> {
    Log.d('MAIL', `resume requested (state ${this.current.kind})`);
    if (this.current.kind === 'ready') return true;
    // A closed mailbox stays closed: what it kept is erased, and only a new sign-in reopens one.
    if (this.current.kind === 'closed') return false;
    try {
      await this.renewOnce();
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
   * @throws {MailError} typed; `session_expired` while the password is asked for, `not_signed_in`
   * with no session.
   */
  async call(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withToken((token) => this.soap.call(body, token));
  }

  /**
   * {@link call} over ANOTHER connection: the new-mail watcher's blocking `WaitSetRequest` holds its
   * connection for up to a minute, and lot 1's client sends one request at a time per connection, so
   * on the screens' connection it would stall every other call. Same token, same single renewal.
   */
  async callOver(
    channel: Pick<MailSoap, 'call'>,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.withToken((token) => channel.call(body, token));
  }

  /**
   * One plain HTTP exchange carrying the session as Zimbra's `ZM_AUTH_TOKEN` cookie (the upload
   * servlet, an attachment download), read by `read`, renewed once like {@link call}.
   */
  async http<T>(build: (token: string) => HttpRequest, read: HttpAnswerReader<T>): Promise<T> {
    return this.withToken(async (token) => read(await this.soap.exchange(build(token))));
  }

  /**
   * Signs out: the epoch moves, the token is dropped and the remembered password forgotten BEFORE
   * the first await (a renewal or a sign-in in flight finds the epoch moved and installs nothing),
   * then the server is told, then the connection closed.
   *
   * `keepRemembered` keeps the sealed password: ONLY for the server's switch turned off (lead,
   * 2026-11-27, review M-5) - a kill switch, not the reader's choice to forget. A reader's sign-out,
   * a Canari sign-out and D8 forget it.
   */
  async signOut(options: { keepRemembered?: boolean } = {}): Promise<void> {
    Log.d(
      'MAIL',
      `sign-out requested${options.keepRemembered ? ' (remembered password kept)' : ''}`
    );
    this.epoch++;
    const token = this.token;
    this.token = null;
    this.authName = null;
    if (!options.keepRemembered) forgetMailPassword(this.context.userId, this.store);
    this.setState({ kind: 'signed_out' });
    if (token) await this.endQuietly(token);
    this.soap.close();
  }

  /** Ends `token` on the server; a failure is logged, never thrown (it lapses by itself). */
  private async endQuietly(token: string): Promise<void> {
    try {
      await this.soap.call(endSessionRequest(), token);
    } catch (err) {
      Log.w('MAIL', 'a session was not ended on the server', classifyMailFailure(err));
    }
  }

  /**
   * `AuthRequest` then `GetInfoRequest`: a token and the canonical account, eligible (D1). Installs
   * NOTHING - the caller does, in the same synchronous step as its last epoch check. A token obtained
   * for an epoch that has moved is ended on the server and the call ends `not_signed_in`. Faults are
   * classified as answers to the session's own sign-in (`auth`).
   */
  private async authenticate(
    name: string,
    password: string,
    epoch: number
  ): Promise<{ token: string; account: MailAccount }> {
    let token: string;
    try {
      token = parseAuth(await this.soap.call(authRequest(name, password))).token;
    } catch (err) {
      if (epoch !== this.epoch) throw superseded();
      throw this.settle(classifyMailFailure(err, 'auth'), name);
    }
    if (epoch !== this.epoch) {
      await this.endQuietly(token);
      throw superseded();
    }
    let account: MailAccount;
    try {
      account = parseInfo(await this.soap.call(getInfoRequest(), token));
    } catch (err) {
      if (epoch !== this.epoch) {
        await this.endQuietly(token);
        throw superseded();
      }
      const failure = this.settle(classifyMailFailure(err, 'auth'), name);
      if (failure.kind !== 'account_closed') await this.endQuietly(token);
      throw failure;
    }
    if (epoch !== this.epoch) {
      await this.endQuietly(token);
      throw superseded();
    }
    if (mailClassOf(account.address) === null) {
      Log.w('MAIL', 'sign-in refused: the canonical address is not on an eligible domain');
      await this.endQuietly(token);
      throw new MailError('not_eligible', 'canonical-domain');
    }
    if (epoch !== this.epoch) throw superseded();
    Log.d('MAIL', 'authenticated');
    return { token, account };
  }

  /** Runs `op` with the token; on a session-ended answer, renews ONCE and runs it ONCE more. */
  private async withToken<T>(op: (token: string) => Promise<T>): Promise<T> {
    if (this.renewing) await this.renewing.catch(() => undefined);
    const token = this.token;
    if (!token) {
      // Asked for its password, the session is not renewed again by every call that comes along.
      throw this.current.kind === 'needs_password'
        ? new MailError('session_expired', 'password-needed')
        : new MailError('not_signed_in', 'no-token');
    }
    const epoch = this.epoch;
    try {
      return await op(token);
    } catch (err) {
      const failure = classifyMailFailure(err);
      if (failure.kind !== 'session_expired') throw this.settle(failure, this.authName);
      if (epoch !== this.epoch) throw superseded();
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
        if (second.kind === 'session_expired' && this.token === renewed) {
          Log.w('MAIL', 'ERROR: a freshly renewed session was refused - the password is asked');
          this.dropToken('session_refused', this.authName);
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
    return this.renewOnce();
  }

  /** The renewal in flight, or a new one: never two at once. */
  private renewOnce(): Promise<void> {
    if (!this.renewing) {
      this.renewing = this.renewFromRemembered().finally(() => {
        this.renewing = null;
      });
    }
    return this.renewing;
  }

  /**
   * Signs in again from the remembered password, or sets the state that asks for it. The address is
   * the account's own (never the one stored beside the password): an entry for another address is
   * removed, and an ineligible address is refused before a byte is sent.
   */
  private async renewFromRemembered(): Promise<void> {
    const epoch = this.epoch;
    const known =
      this.current.kind === 'ready'
        ? this.current.account.address
        : this.current.kind === 'needs_password' || this.current.kind === 'unavailable'
          ? this.current.account
          : this.authName;
    const key = this.context.deviceKey();
    if (!key) {
      this.dropToken('device_locked', known);
      throw new MailError('session_expired', 'device-locked');
    }
    const address = await this.context.mailAddress();
    if (epoch !== this.epoch) throw superseded();
    if (address === null) {
      Log.w('MAIL', 'renewal refused: the account identity carries no address');
      throw new MailError('address_unknown', 'no-identity-address');
    }
    const name = normalized(address);
    if (mailClassOf(name) === null) {
      Log.w('MAIL', 'renewal refused: the account address is not on an eligible domain');
      throw new MailError('not_eligible', 'domain');
    }
    const read = await readRememberedMailPassword(this.context.userId, key, this.store);
    if (epoch !== this.epoch) throw superseded();
    if (read.kind === 'none') {
      if (this.authName === null && this.current.kind === 'signed_out') {
        Log.d('MAIL', 'nothing is remembered: the mailbox stays signed out');
      } else {
        this.dropToken('not_remembered', known ?? name);
      }
      throw new MailError('session_expired', 'not-remembered');
    }
    if (read.kind === 'unopenable') {
      forgetMailPassword(this.context.userId, this.store);
      this.dropToken('remembered_unopenable', known ?? name);
      throw new MailError('session_expired', 'remembered-unopenable');
    }
    const { remembered } = read;
    if (normalized(remembered.account) !== name) {
      Log.w('MAIL', 'ERROR: the remembered password is for another mailbox - removed');
      forgetMailPassword(this.context.userId, this.store);
      this.dropToken('not_remembered', name);
      throw new MailError('session_expired', 'remembered-other-account');
    }
    let signedIn: { token: string; account: MailAccount };
    try {
      signedIn = await this.authenticate(name, remembered.password, epoch);
    } catch (err) {
      const failure = classifyMailFailure(err);
      if (failure.kind === 'bad_credentials' || failure.kind === 'password_change_required') {
        Log.i('MAIL', `the remembered password was refused (${failure.code}) - it is forgotten`);
        forgetMailPassword(this.context.userId, this.store);
        this.dropToken('password_refused', name);
      }
      throw failure;
    }
    this.token = signedIn.token;
    this.authName = name;
    this.setState({ kind: 'ready', account: signedIn.account, remembered: true });
    Log.d('MAIL', 'the session was renewed from the remembered password');
  }

  /** The session is over with nothing to renew it now: the password is asked for `account`. */
  private dropToken(reason: PasswordAskReason, account: string | null): void {
    this.token = null;
    this.setState({ kind: 'needs_password', account, reason });
  }

  /**
   * What a classified failure does to the session, returned to throw: D8 for an account gone, the
   * `unavailable` state (nothing erased) for an inactive one.
   */
  private settle(failure: MailError, account: string | null): MailError {
    if (failure.kind === 'account_closed') {
      Log.i('MAIL', `the sign-in answered ${failure.code}: the account is gone (D8)`);
      this.epoch++;
      this.token = null;
      this.authName = null;
      eraseMailLocalData(this.context.userId, this.store);
      this.soap.close();
      this.setState({ kind: 'closed', account });
    } else if (failure.kind === 'account_unavailable') {
      Log.i(
        'MAIL',
        `the mailbox answered ${failure.code}: the account is inactive - nothing erased`
      );
      this.token = null;
      this.setState({ kind: 'unavailable', account });
    }
    return failure;
  }
}
