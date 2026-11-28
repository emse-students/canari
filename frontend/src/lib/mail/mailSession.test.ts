// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeZimbra, zimbraBody, zimbraFault, type FakeZimbraRequest } from '../../test/mailFakes';
import { gateStorage, holdStorageForKeyChange } from '$lib/db/deviceKeyGate';
import type { IStorage } from '$lib/db/types';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { MailError } from './mailErrors';
import { MailSession, type MailContext, type MailSessionState, type MailSoap } from './mailSession';
import { readRememberedMailPassword, rememberMailPassword } from './sealedMailPassword';
import { ZimbraSoapClient } from './soapClient';
import { getFolderRequest } from './zimbraRequests';

/**
 * THE MAIL SESSION (D6, D7, D8): sign-in, the remembered password, the renewal driven by the
 * server's answer - exactly once for every call that saw the same token end - the epoch that keeps a
 * sign-out from being undone by an await in flight, and the erasure of an account that is gone.
 */

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const USER = 'canari-user-1';
const ADDRESS = 'ada.lovelace@etu.emse.fr';
const GOOD = 'right-password';

/** A mailbox that issues tokens for {@link GOOD}, answers GetInfo and GetFolder while they live. */
function mailbox() {
  const live = new Set<string>();
  let issued = 0;
  /** Codes to answer the next AuthRequests with, in order, instead of a token. */
  const authFaults: string[] = [];
  /** A code GetInfo answers with, when set. */
  let infoFault: string | null = null;
  /** A code every other token-carrying call answers with, when set. */
  let callFault: string | null = null;
  const zimbra = new FakeZimbra((r: FakeZimbraRequest) => {
    const soap = r.soap!;
    if (soap.name === 'AuthRequest') {
      const fault = authFaults.shift();
      if (fault) return zimbraFault(fault);
      const password = (soap.element.password as { _content: string })._content;
      if (password !== GOOD) return zimbraFault('account.AUTH_FAILED');
      const token = `token-${++issued}`;
      live.add(token);
      return zimbraBody({
        AuthResponse: { authToken: [{ _content: token }], lifetime: 172800000 },
      });
    }
    if (soap.name === 'EndSessionRequest') {
      live.delete(soap.token!);
      return zimbraBody({ EndSessionResponse: {} });
    }
    if (soap.name === 'GetInfoRequest' && infoFault) return zimbraFault(infoFault);
    if (soap.name !== 'GetInfoRequest' && callFault) return zimbraFault(callFault);
    if (!soap.token || !live.has(soap.token)) return zimbraFault('service.AUTH_EXPIRED');
    if (soap.name === 'GetInfoRequest') {
      return zimbraBody({
        GetInfoResponse: {
          name: ADDRESS,
          attrs: { _attrs: { displayName: 'Ada', zimbraMailAlias: 'ada@emse.fr' } },
        },
      });
    }
    return zimbraBody({ GetFolderResponse: { folder: [{ id: '1', folder: [] }] } });
  });
  return {
    zimbra,
    authFaults,
    expireAll: () => live.clear(),
    failInfoWith: (code: string | null) => (infoFault = code),
    failCallsWith: (code: string | null) => (callFault = code),
    authCount: () => zimbra.soapNames.filter((n) => n === 'AuthRequest').length,
    ended: () =>
      zimbra.requests.filter((r) => r.soap?.name === 'EndSessionRequest').map((r) => r.soap!.token),
  };
}

interface Options {
  key?: string | null;
  address?: string | null;
  soap?: (real: MailSoap) => MailSoap;
  store?: Storage;
}

function session(server: ReturnType<typeof mailbox>, options: Options = {}) {
  let key = options.key === undefined ? KEY : options.key;
  let address = options.address === undefined ? ADDRESS : options.address;
  const context: MailContext = {
    userId: USER,
    deviceKey: () => key,
    mailAddress: async () => address,
  };
  const real = new ZimbraSoapClient(server.zimbra.openStream);
  const s = new MailSession(options.soap ? options.soap(real) : real, context, options.store);
  const states: MailSessionState['kind'][] = [];
  s.onState((state) => states.push(state.kind));
  return {
    s,
    states,
    lock: () => (key = null),
    becomes: (next: string | null) => (address = next),
  };
}

/** A SOAP client whose answer to `name` waits until the test releases it. */
function holding(name: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  const wrap = (real: MailSoap): MailSoap => ({
    call: async (body, token) => {
      const answer = await real.call(body, token);
      if (name in body) {
        reached();
        await gate;
      }
      return answer;
    },
    exchange: (request) => real.exchange(request),
    close: () => real.close(),
  });
  return { wrap, arrived, release };
}

beforeEach(() => localStorage.clear());

describe('MailSession.signIn', () => {
  it('signs in to the identity address, holds the token in memory only, remembers nothing unticked', async () => {
    const server = mailbox();
    const { s } = session(server, { address: ' Ada.Lovelace@ETU.emse.fr ' });
    expect(await s.eligibility()).toBe('eligible');
    const account = await s.signIn(GOOD, false);
    expect(account).toEqual({ address: ADDRESS, displayName: 'Ada', aliases: ['ada@emse.fr'] });
    expect(s.state).toMatchObject({ kind: 'ready', remembered: false });
    expect(server.zimbra.soapNames).toEqual(['AuthRequest', 'GetInfoRequest']);
    const auth = server.zimbra.requests[0].soap!.element as { account: { _content: string } };
    expect(auth.account._content).toBe(ADDRESS);
    expect(localStorage.length).toBe(0);
  });

  it('refuses an address off the eligible domains before any byte is sent (D1)', async () => {
    const server = mailbox();
    const { s } = session(server, { address: 'ada@gmail.com' });
    expect(await s.eligibility()).toBe('not_eligible');
    await expect(s.signIn(GOOD, true)).rejects.toMatchObject({ kind: 'not_eligible' });
    expect(server.zimbra.requests).toHaveLength(0);
  });

  it('an identity with no address has no mailbox to sign in to', async () => {
    const server = mailbox();
    const { s } = session(server, { address: null });
    expect(await s.eligibility()).toBe('unknown');
    await expect(s.signIn(GOOD, true)).rejects.toMatchObject({ kind: 'address_unknown' });
    expect(server.zimbra.requests).toHaveLength(0);
  });

  it('types a wrong password as bad_credentials, and keeps nothing', async () => {
    const server = mailbox();
    const { s } = session(server);
    await expect(s.signIn('wrong', true)).rejects.toMatchObject({
      name: 'MailError',
      kind: 'bad_credentials',
      code: 'account.AUTH_FAILED',
    });
    expect(s.state.kind).toBe('signed_out');
    expect(localStorage.length).toBe(0);
  });

  it('remembers the password SEALED under the device key, never in the clear (D6)', async () => {
    const server = mailbox();
    const { s } = session(server);
    await s.signIn(GOOD, true);
    const raw = localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))!;
    expect(raw).toBeTruthy();
    expect(raw).not.toContain(GOOD);
    expect(raw).not.toContain(ADDRESS);
    expect(await readRememberedMailPassword(USER, KEY)).toEqual({
      kind: 'opened',
      remembered: { account: ADDRESS, password: GOOD },
    });
    expect((await readRememberedMailPassword(USER, OTHER_KEY)).kind).toBe('unopenable');
  });

  it('an unticked sign-in forgets a password remembered before', async () => {
    const server = mailbox();
    const { s } = session(server);
    await s.signIn(GOOD, true);
    await s.signIn(GOOD, false);
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).toBeNull();
  });

  it('a sign-in over a live session ends the session it replaces on the server', async () => {
    const server = mailbox();
    const { s } = session(server);
    await s.signIn(GOOD, false);
    await s.signIn(GOOD, false);
    await vi.waitFor(() => expect(server.ended()).toEqual(['token-1']));
    await s.call(getFolderRequest());
    expect(server.zimbra.requests.at(-1)!.soap!.token).toBe('token-2');
  });

  it('does not remember while the device key is not held, and says so in the state', async () => {
    const server = mailbox();
    const { s } = session(server, { key: null });
    await s.signIn(GOOD, true);
    expect(s.state).toMatchObject({ kind: 'ready', remembered: false });
    expect(localStorage.length).toBe(0);
  });

  it('a password that cannot be stored still ends ready, typed remembered: false - never half open', async () => {
    const server = mailbox();
    const failing: Storage = {
      get length() {
        return localStorage.length;
      },
      clear: () => localStorage.clear(),
      key: (i) => localStorage.key(i),
      getItem: (k) => localStorage.getItem(k),
      removeItem: (k) => localStorage.removeItem(k),
      setItem: () => {
        throw new Error('quota');
      },
    };
    const { s } = session(server, { store: failing });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(s.signIn(GOOD, true)).resolves.toMatchObject({ address: ADDRESS });
    warn.mockRestore();
    expect(s.state).toMatchObject({ kind: 'ready', remembered: false });
    await s.call(getFolderRequest());
  });
});

describe('MailSession and a sign-out in flight (the epoch)', () => {
  it('a sign-out while a renewal AuthRequest is out: the new token is ended, never installed', async () => {
    const server = mailbox();
    const hold = holding('AuthRequest');
    const { s } = session(server, { soap: hold.wrap });
    // The first sign-in also goes through the wrapper: let it pass.
    const signingIn = s.signIn(GOOD, true);
    await hold.arrived;
    hold.release();
    await signingIn;

    const second = holding('AuthRequest');
    const { s: renewing } = session(server, { soap: second.wrap });
    await rememberMailPassword(USER, KEY, { account: ADDRESS, password: GOOD });
    const resumed = renewing.resume();
    await second.arrived;
    await renewing.signOut();
    second.release();
    await expect(resumed).rejects.toMatchObject({ kind: 'not_signed_in' });
    expect(renewing.state.kind).toBe('signed_out');
    await expect(renewing.call(getFolderRequest())).rejects.toMatchObject({
      kind: 'not_signed_in',
    });
    // token-1 was the first session's; the renewal brought token-2 back after the sign-out.
    expect(server.ended()).toContain('token-2');
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).toBeNull();
  });

  it('a sign-out while a sign-in AuthRequest is out: nothing installed, nothing remembered', async () => {
    const server = mailbox();
    const hold = holding('AuthRequest');
    const { s } = session(server, { soap: hold.wrap });
    const signingIn = s.signIn(GOOD, true);
    await hold.arrived;
    await s.signOut();
    hold.release();
    await expect(signingIn).rejects.toMatchObject({ kind: 'not_signed_in' });
    expect(s.state.kind).toBe('signed_out');
    expect(server.ended()).toEqual(['token-1']);
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).toBeNull();
  });

  it('a sign-out while the remembered write waits behind the device-key gate: not written back', async () => {
    const keyA = btoa(String.fromCharCode(...new Uint8Array(32).fill(41)));
    const keyB = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)));
    const server = mailbox();
    const { s } = session(server, { key: keyA });
    const gated = gateStorage({ ping: async () => {} } as unknown as IStorage, USER);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const change = holdStorageForKeyChange(gated, keyA, keyB, () => held);
    const signingIn = s.signIn(GOOD, true);
    await vi.waitFor(() => expect(server.zimbra.soapNames).toContain('GetInfoRequest'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await s.signOut();
    release();
    await change;
    await expect(signingIn).rejects.toMatchObject({ kind: 'not_signed_in' });
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).toBeNull();
    expect(s.state.kind).toBe('signed_out');
  });
});

describe('MailSession renewal (driven by the answer, never a clock)', () => {
  it('renews ONCE from the remembered password for every call that saw the token end', async () => {
    const server = mailbox();
    const { s } = session(server);
    await s.signIn(GOOD, true);
    server.expireAll();
    const results = await Promise.all([
      s.call(getFolderRequest()),
      s.call(getFolderRequest()),
      s.call(getFolderRequest()),
    ]);
    expect(results).toHaveLength(3);
    expect(server.authCount()).toBe(2);
    expect(s.state.kind).toBe('ready');
    // Each call was refused once with the old token, then sent once with the new one.
    const folderCalls = server.zimbra.requests.filter((r) => r.soap?.name === 'GetFolderRequest');
    expect(folderCalls.map((r) => r.soap!.token)).toEqual([
      'token-1',
      'token-1',
      'token-1',
      'token-2',
      'token-2',
      'token-2',
    ]);
  });

  it('with nothing remembered, asks for the password and renews nothing more', async () => {
    const server = mailbox();
    const { s } = session(server);
    await s.signIn(GOOD, false);
    server.expireAll();
    await expect(s.call(getFolderRequest())).rejects.toMatchObject({ kind: 'session_expired' });
    expect(s.state).toEqual({ kind: 'needs_password', account: ADDRESS, reason: 'not_remembered' });
    expect(server.authCount()).toBe(1);
    const sent = server.zimbra.requests.length;
    await expect(s.call(getFolderRequest())).rejects.toMatchObject({ kind: 'session_expired' });
    expect(server.zimbra.requests.length).toBe(sent);
  });

  it('forgets a remembered password the server refuses, and never replays it', async () => {
    const server = mailbox();
    const { s } = session(server);
    await s.signIn(GOOD, true);
    server.expireAll();
    server.authFaults.push('account.AUTH_FAILED');
    await expect(s.call(getFolderRequest())).rejects.toMatchObject({ kind: 'session_expired' });
    expect(s.state).toEqual({
      kind: 'needs_password',
      account: ADDRESS,
      reason: 'password_refused',
    });
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).toBeNull();
    expect(server.authCount()).toBe(2);
  });

  it('a renewal the server failed keeps the old token, so the next call renews again', async () => {
    const server = mailbox();
    const { s } = session(server);
    await s.signIn(GOOD, true);
    server.expireAll();
    server.authFaults.push('service.FAILURE');
    await expect(s.call(getFolderRequest())).rejects.toMatchObject({ kind: 'server' });
    expect(s.state.kind).toBe('ready');
    await s.call(getFolderRequest());
    expect(server.authCount()).toBe(3);
  });

  it('a session refused again right after its renewal asks for the password, said as such', async () => {
    const server = mailbox();
    const { s } = session(server);
    await s.signIn(GOOD, true);
    server.failCallsWith('service.AUTH_EXPIRED');
    await expect(s.call(getFolderRequest())).rejects.toMatchObject({ kind: 'session_expired' });
    expect(s.state).toEqual({
      kind: 'needs_password',
      account: ADDRESS,
      reason: 'session_refused',
    });
    expect(server.authCount()).toBe(2);
  });

  it('a locked device asks for the password rather than renewing', async () => {
    const server = mailbox();
    const { s, lock } = session(server);
    await s.signIn(GOOD, true);
    lock();
    server.expireAll();
    await expect(s.call(getFolderRequest())).rejects.toMatchObject({ kind: 'session_expired' });
    expect(s.state).toEqual({ kind: 'needs_password', account: ADDRESS, reason: 'device_locked' });
  });

  it('resume opens the mailbox from the remembered password, and stays signed out without one', async () => {
    const server = mailbox();
    const first = session(server).s;
    expect(await first.resume()).toBe(false);
    expect(first.state.kind).toBe('signed_out');
    await rememberMailPassword(USER, KEY, { account: ADDRESS, password: GOOD });
    const second = session(server).s;
    expect(await second.resume()).toBe(true);
    expect(second.state).toMatchObject({ kind: 'ready', remembered: true });
  });

  it('two resumes at once share ONE renewal', async () => {
    const server = mailbox();
    await rememberMailPassword(USER, KEY, { account: ADDRESS, password: GOOD });
    const { s } = session(server);
    expect(await Promise.all([s.resume(), s.resume()])).toEqual([true, true]);
    expect(server.authCount()).toBe(1);
  });

  it('a remembered password the device key does not open is REMOVED, and asked for', async () => {
    const server = mailbox();
    await rememberMailPassword(USER, OTHER_KEY, { account: ADDRESS, password: GOOD });
    const { s } = session(server);
    expect(await s.resume()).toBe(false);
    expect(s.state).toMatchObject({ kind: 'needs_password', reason: 'remembered_unopenable' });
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).toBeNull();
    expect(server.zimbra.requests).toHaveLength(0);
  });

  it('a remembered password for another address than the identity is removed, no byte sent', async () => {
    const server = mailbox();
    await rememberMailPassword(USER, KEY, { account: 'someone@etu.emse.fr', password: GOOD });
    const { s } = session(server);
    expect(await s.resume()).toBe(false);
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).toBeNull();
    expect(server.zimbra.requests).toHaveLength(0);
  });

  it('resume checks the identity address is eligible before any byte', async () => {
    const server = mailbox();
    await rememberMailPassword(USER, KEY, { account: 'ada@gmail.com', password: GOOD });
    const { s } = session(server, { address: 'ada@gmail.com' });
    await expect(s.resume()).rejects.toMatchObject({ kind: 'not_eligible' });
    expect(server.zimbra.requests).toHaveLength(0);
  });
});

describe('MailSession and an account the school ended (D8)', () => {
  it('NO_SUCH_ACCOUNT answered to its own sign-in erases the mail data, and only it', async () => {
    const server = mailbox();
    const { s } = session(server);
    localStorage.setItem(ACCOUNT_KEY.backupRecoveryCode(USER), 'kept');
    localStorage.setItem('unrelated', 'kept');
    await s.signIn(GOOD, true);
    server.expireAll();
    server.failInfoWith('account.NO_SUCH_ACCOUNT');
    await expect(s.call(getFolderRequest())).rejects.toMatchObject({ kind: 'account_closed' });
    expect(s.state).toEqual({ kind: 'closed', account: ADDRESS });
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.backupRecoveryCode(USER))).toBe('kept');
    expect(localStorage.getItem('unrelated')).toBe('kept');
    expect(await s.resume()).toBe(false);
    expect(s.state.kind).toBe('closed');
  });

  it('NO_SUCH_ACCOUNT on any other call names another account: not_found, nothing erased', async () => {
    const server = mailbox();
    const { s } = session(server);
    await s.signIn(GOOD, true);
    server.failCallsWith('account.NO_SUCH_ACCOUNT');
    await expect(s.call(getFolderRequest())).rejects.toMatchObject({ kind: 'not_found' });
    expect(s.state.kind).toBe('ready');
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).not.toBeNull();
  });

  it('ACCOUNT_INACTIVE (also locked or pending) is unavailable: nothing erased', async () => {
    const server = mailbox();
    const { s } = session(server);
    await s.signIn(GOOD, true);
    server.failCallsWith('account.ACCOUNT_INACTIVE');
    await expect(s.call(getFolderRequest())).rejects.toMatchObject({
      kind: 'account_unavailable',
    });
    expect(s.state).toEqual({ kind: 'unavailable', account: ADDRESS });
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).not.toBeNull();
    // The next resume tries again, once the school has reactivated it.
    server.failCallsWith(null);
    expect(await s.resume()).toBe(true);
  });

  it('maintenance is temporary: nothing is erased', async () => {
    const server = mailbox();
    const { s } = session(server);
    await s.signIn(GOOD, true);
    server.failCallsWith('account.MAINTENANCE_MODE');
    await expect(s.call(getFolderRequest())).rejects.toMatchObject({ kind: 'maintenance' });
    expect(s.state.kind).toBe('ready');
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).not.toBeNull();
  });
});

describe('MailSession.rememberedForNativeWatch (lot 4b)', () => {
  it('hands the password over only from a ready, remembered mailbox with the device key held', async () => {
    const server = mailbox();
    const { s, lock } = session(server);
    expect(await s.rememberedForNativeWatch()).toBeNull();
    await s.signIn(GOOD, false);
    expect(await s.rememberedForNativeWatch()).toBeNull();
    await s.signIn(GOOD, true);
    expect(await s.rememberedForNativeWatch()).toEqual({ account: ADDRESS, password: GOOD });
    lock();
    expect(await s.rememberedForNativeWatch()).toBeNull();
  });

  it('hands over the canonical address of the open mailbox, never the spelling stored beside the password', async () => {
    const server = mailbox();
    // The address the password was typed for, in another spelling than the server's.
    const { s } = session(server, { address: 'Ada.Lovelace@ETU.emse.fr' });
    await s.signIn(GOOD, true);
    expect(await s.rememberedForNativeWatch()).toEqual({ account: ADDRESS, password: GOOD });
  });
});

describe('MailSession.signOut', () => {
  it('forgets the password and the token before telling the server, then closes', async () => {
    const server = mailbox();
    const { s, states } = session(server);
    await s.signIn(GOOD, true);
    const signedOut = s.signOut();
    // Before the first await: nothing left to renew with.
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).toBeNull();
    expect(s.state.kind).toBe('signed_out');
    await signedOut;
    expect(server.zimbra.soapNames.at(-1)).toBe('EndSessionRequest');
    expect(server.zimbra.streams[0].ended).toBe(true);
    expect(states).toEqual(['ready', 'signed_out']);
    await expect(s.call(getFolderRequest())).rejects.toBeInstanceOf(MailError);
  });
});
