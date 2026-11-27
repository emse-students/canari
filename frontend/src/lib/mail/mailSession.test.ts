// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeZimbra, zimbraBody, zimbraFault, type FakeZimbraRequest } from '../../test/mailFakes';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { MailError } from './mailErrors';
import { MailSession, type MailContext, type MailSessionState } from './mailSession';
import { readRememberedMailPassword, rememberMailPassword } from './sealedMailPassword';
import { ZimbraSoapClient } from './soapClient';
import { getFolderRequest } from './zimbraRequests';

/**
 * THE MAIL SESSION (D6, D7, D8): sign-in, the remembered password, the renewal driven by the
 * server's answer - exactly once for every call that saw the same token end - and the erasure of a
 * closed account.
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
  /** A code every token-carrying call answers with, when set. */
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
    if (callFault) return zimbraFault(callFault);
    if (!soap.token || !live.has(soap.token)) return zimbraFault('service.AUTH_EXPIRED');
    if (soap.name === 'GetInfoRequest') {
      return zimbraBody({
        GetInfoResponse: { name: ADDRESS, attrs: { _attrs: { displayName: 'Ada' } } },
      });
    }
    if (soap.name === 'EndSessionRequest') {
      live.delete(soap.token);
      return zimbraBody({ EndSessionResponse: {} });
    }
    return zimbraBody({ GetFolderResponse: { folder: [{ id: '1', folder: [] }] } });
  });
  return {
    zimbra,
    authFaults,
    expireAll: () => live.clear(),
    failCallsWith: (code: string | null) => (callFault = code),
    authCount: () => zimbra.soapNames.filter((n) => n === 'AuthRequest').length,
  };
}

function session(
  server: ReturnType<typeof mailbox>,
  key: string | null = KEY,
  address: string | null = ADDRESS
) {
  const context: MailContext = {
    userId: USER,
    deviceKey: () => key,
    mailAddress: async () => address,
  };
  const s = new MailSession(new ZimbraSoapClient(server.zimbra.openStream), context);
  const states: MailSessionState['kind'][] = [];
  s.onState((state) => states.push(state.kind));
  return { s, states };
}

beforeEach(() => localStorage.clear());

describe('MailSession.signIn', () => {
  it('signs in, holds the token in memory only, and remembers nothing unticked', async () => {
    const server = mailbox();
    const { s } = session(server, KEY, ' Ada.Lovelace@ETU.emse.fr ');
    expect(await s.eligibility()).toBe('eligible');
    const account = await s.signIn(GOOD, false);
    expect(account).toEqual({ address: ADDRESS, displayName: 'Ada' });
    expect(s.state).toMatchObject({ kind: 'ready', remembered: false });
    expect(server.zimbra.soapNames).toEqual(['AuthRequest', 'GetInfoRequest']);
    const auth = server.zimbra.requests[0].soap!.element as { account: { _content: string } };
    expect(auth.account._content).toBe(ADDRESS);
    expect(localStorage.length).toBe(0);
  });

  it('refuses an address off the eligible domains before any byte is sent (D1)', async () => {
    const server = mailbox();
    const { s } = session(server, KEY, 'ada@gmail.com');
    expect(await s.eligibility()).toBe('not_eligible');
    await expect(s.signIn(GOOD, true)).rejects.toMatchObject({ kind: 'not_eligible' });
    expect(server.zimbra.requests).toHaveLength(0);
  });

  it('an identity with no address has no mailbox to sign in to', async () => {
    const server = mailbox();
    const { s } = session(server, KEY, null);
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

  it('does not remember while the device key is not held, and says so in the state', async () => {
    const server = mailbox();
    const { s } = session(server, null);
    await s.signIn(GOOD, true);
    expect(s.state).toMatchObject({ kind: 'ready', remembered: false });
    expect(localStorage.length).toBe(0);
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

  it('with nothing remembered, asks for the password and sends nothing more', async () => {
    const server = mailbox();
    const { s } = session(server);
    await s.signIn(GOOD, false);
    server.expireAll();
    await expect(s.call(getFolderRequest())).rejects.toMatchObject({ kind: 'session_expired' });
    expect(s.state).toEqual({ kind: 'needs_password', account: ADDRESS, reason: 'not_remembered' });
    expect(server.authCount()).toBe(1);
    await expect(s.call(getFolderRequest())).rejects.toMatchObject({ kind: 'not_signed_in' });
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

  it('a renewal the network failed keeps the old token, so the next call renews again', async () => {
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

  it('a locked device asks for the password rather than renewing', async () => {
    const server = mailbox();
    let key: string | null = KEY;
    const s = new MailSession(new ZimbraSoapClient(server.zimbra.openStream), {
      userId: USER,
      deviceKey: () => key,
      mailAddress: async () => ADDRESS,
    });
    await s.signIn(GOOD, true);
    key = null;
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

  it('resume with a password the device key does not open asks for it', async () => {
    const server = mailbox();
    await rememberMailPassword(USER, OTHER_KEY, { account: ADDRESS, password: GOOD });
    const { s } = session(server);
    expect(await s.resume()).toBe(false);
    expect(s.state).toMatchObject({ kind: 'needs_password', reason: 'remembered_unopenable' });
    expect(server.zimbra.requests).toHaveLength(0);
  });
});

describe('MailSession and a closed account (D8)', () => {
  it('erases the mail data, and only it, and says the account is closed', async () => {
    const server = mailbox();
    const { s } = session(server);
    localStorage.setItem(ACCOUNT_KEY.backupRecoveryCode(USER), 'kept');
    localStorage.setItem('unrelated', 'kept');
    await s.signIn(GOOD, true);
    server.failCallsWith('account.ACCOUNT_INACTIVE');
    await expect(s.call(getFolderRequest())).rejects.toMatchObject({ kind: 'account_closed' });
    expect(s.state).toEqual({ kind: 'closed', account: ADDRESS });
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.backupRecoveryCode(USER))).toBe('kept');
    expect(localStorage.getItem('unrelated')).toBe('kept');
    expect(await s.resume()).toBe(false);
    expect(s.state.kind).toBe('closed');
  });

  it('a closed account met at the renewal erases too', async () => {
    const server = mailbox();
    const { s } = session(server);
    await s.signIn(GOOD, true);
    server.expireAll();
    server.authFaults.push('account.ACCOUNT_INACTIVE');
    await expect(s.call(getFolderRequest())).rejects.toMatchObject({ kind: 'account_closed' });
    expect(s.state.kind).toBe('closed');
    expect(localStorage.getItem(ACCOUNT_KEY.mailSealedPassword(USER))).toBeNull();
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
