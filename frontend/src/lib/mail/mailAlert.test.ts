import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import {
  ALERT_ADDRESS_PREF,
  ALERT_ENABLED_PREF,
  alertAddress,
  httpMailAlertServer,
  MailAlertServerError,
  newAlertToken,
  parseAlertAddress,
  readAlertRecord,
  syncMailAlert,
  type MailAlertServer,
  type MailAlertServerState,
} from './mailAlert';
import { parsePrefs } from './zimbraParse';
import { getPrefsRequest, modifyPrefsRequest } from './zimbraRequests';

vi.mock('$lib/utils/Log', () => ({
  Log: { d: vi.fn(), i: vi.fn(), w: vi.fn(), e: vi.fn() },
}));

const DOMAIN = 'alerte.example.test';
const USER = 'u1';
const DEVICE = 'dev-a';

/** A memory Storage. */
function memoryStore(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}

/**
 * A mailbox holding the account's preferences as Zimbra would: an absent preference is not listed,
 * and an empty value written UNSETS it.
 */
function fakeMailbox(initial: Record<string, string> = {}) {
  const prefs = new Map(Object.entries(initial));
  const writes: Record<string, string>[] = [];
  let failWrite = false;
  const call = vi.fn(async (body: Record<string, any>) => {
    if (body.GetPrefsRequest) {
      const names: string[] = body.GetPrefsRequest.pref.map((p: { name: string }) => p.name);
      return {
        GetPrefsResponse: {
          pref: names.filter((n) => prefs.has(n)).map((n) => ({ name: n, _content: prefs.get(n) })),
        },
      };
    }
    if (body.ModifyPrefsRequest) {
      if (failWrite) throw new Error('write refused');
      const write: Record<string, string> = {};
      for (const p of body.ModifyPrefsRequest.pref as { name: string; _content: string }[]) {
        write[p.name] = p._content;
        if (p._content === '') prefs.delete(p.name);
        else prefs.set(p.name, p._content);
      }
      writes.push(write);
      return { ModifyPrefsResponse: {} };
    }
    throw new Error('unexpected request');
  });
  return {
    mailbox: { call } as any,
    prefs,
    writes,
    failNextWrites() {
      failWrite = true;
    },
  };
}

/** A server holding one token per account and the devices that subscribed to it. */
function fakeServer(mode: 'none' | 'cloudflare' = 'cloudflare', domain: string | null = DOMAIN) {
  let token: string | null = null;
  const devices = new Set<string>();
  const server: MailAlertServer & { mode: typeof mode } = {
    mode,
    state: vi.fn(async (deviceId: string, asked: string | null): Promise<MailAlertServerState> => ({
      mode: server.mode,
      domain,
      deviceSubscribed: devices.has(deviceId),
      tokenLive: asked !== null && asked === token && devices.size > 0,
      devices: devices.size,
    })),
    subscribe: vi.fn(async (deviceId: string, t: string) => {
      if (server.mode !== 'cloudflare') throw new MailAlertServerError('off', 409);
      if (t !== token) devices.clear();
      token = t;
      devices.add(deviceId);
      return { domain: domain! };
    }),
    unsubscribe: vi.fn(async (deviceId: string) => {
      devices.delete(deviceId);
      if (devices.size === 0) token = null;
      return { remaining: devices.size };
    }),
  };
  return { server, devices, token: () => token };
}

describe('the opaque address', () => {
  it('round-trips a token and refuses any other shape', () => {
    const token = 'a'.repeat(32);
    expect(alertAddress(token, 'ALERTE.Example.test')).toBe(`n-${token}@alerte.example.test`);
    expect(parseAlertAddress(alertAddress(token, DOMAIN))).toEqual({ token, domain: DOMAIN });
    expect(parseAlertAddress('me@example.test')).toBeNull();
    expect(parseAlertAddress(`n-${'a'.repeat(31)}@x.test`)).toBeNull();
    expect(parseAlertAddress(`n-${'g'.repeat(32)}@x.test`)).toBeNull();
    expect(parseAlertAddress('')).toBeNull();
  });

  it('a new token is 128 bits of hex', () => {
    expect(newAlertToken()).toMatch(/^[0-9a-f]{32}$/);
    expect(newAlertToken((b) => b.fill(255))).toBe('f'.repeat(32));
  });
});

describe('the Zimbra preference requests', () => {
  it('reads named preferences, an absent one as never set', () => {
    expect(getPrefsRequest([ALERT_ENABLED_PREF])).toEqual({
      GetPrefsRequest: { _jsns: 'urn:zimbraAccount', pref: [{ name: ALERT_ENABLED_PREF }] },
    });
    expect(
      parsePrefs({ GetPrefsResponse: { pref: [{ name: ALERT_ENABLED_PREF, _content: 'TRUE' }] } }, [
        ALERT_ENABLED_PREF,
        ALERT_ADDRESS_PREF,
      ])
    ).toEqual({ [ALERT_ENABLED_PREF]: 'TRUE', [ALERT_ADDRESS_PREF]: '' });
  });

  it('writes values, the empty one unsetting', () => {
    expect(modifyPrefsRequest({ [ALERT_ADDRESS_PREF]: '' })).toEqual({
      ModifyPrefsRequest: {
        _jsns: 'urn:zimbraAccount',
        pref: [{ name: ALERT_ADDRESS_PREF, _content: '' }],
      },
    });
  });
});

describe('syncMailAlert', () => {
  const deps = (mailbox: any, server: MailAlertServer, store: Storage, deviceId = DEVICE) => ({
    userId: USER,
    deviceId,
    mailbox,
    server,
    store,
  });

  it('saves the original, points the alert at a new token, and restores it EXACTLY', async () => {
    const original = { [ALERT_ENABLED_PREF]: 'TRUE', [ALERT_ADDRESS_PREF]: 'me@example.test' };
    const box = fakeMailbox(original);
    const { server, token } = fakeServer();
    const store = memoryStore();

    expect(await syncMailAlert(deps(box.mailbox, server, store), true)).toBe('configured');
    expect(box.prefs.get(ALERT_ADDRESS_PREF)).toBe(alertAddress(token()!, DOMAIN));
    expect(box.prefs.get(ALERT_ENABLED_PREF)).toBe('TRUE');
    expect(readAlertRecord(USER, store)).toEqual({
      v: 1,
      subscribed: true,
      saved: { enabled: 'TRUE', address: 'me@example.test' },
    });

    expect(await syncMailAlert(deps(box.mailbox, server, store), false)).toBe('restored');
    expect(Object.fromEntries(box.prefs)).toEqual(original);
    expect(readAlertRecord(USER, store)).toBeNull();
    expect(token()).toBeNull();
  });

  it('an alert never set is restored to never set', async () => {
    const box = fakeMailbox({});
    const { server } = fakeServer();
    const store = memoryStore();
    await syncMailAlert(deps(box.mailbox, server, store), true);
    await syncMailAlert(deps(box.mailbox, server, store), false);
    expect(box.prefs.size).toBe(0);
  });

  it('is idempotent: a second sync writes nothing', async () => {
    const box = fakeMailbox({});
    const { server } = fakeServer();
    const store = memoryStore();
    await syncMailAlert(deps(box.mailbox, server, store), true);
    expect(await syncMailAlert(deps(box.mailbox, server, store), true)).toBe('unchanged');
    expect(box.writes).toHaveLength(1);
  });

  it('a second device joins the live token, and the alert stays until the last one leaves', async () => {
    const original = { [ALERT_ENABLED_PREF]: 'FALSE', [ALERT_ADDRESS_PREF]: 'me@example.test' };
    const box = fakeMailbox(original);
    const { server, devices } = fakeServer();
    const storeA = memoryStore();
    const storeB = memoryStore();

    await syncMailAlert(deps(box.mailbox, server, storeA, 'dev-a'), true);
    expect(await syncMailAlert(deps(box.mailbox, server, storeB, 'dev-b'), true)).toBe('joined');
    expect(devices.size).toBe(2);
    expect(box.writes).toHaveLength(1);

    // A leaves first: the alert stays for B, and A's saved original goes (documented limit).
    expect(await syncMailAlert(deps(box.mailbox, server, storeA, 'dev-a'), false)).toBe('left');
    expect(parseAlertAddress(box.prefs.get(ALERT_ADDRESS_PREF)!)).not.toBeNull();
    expect(await syncMailAlert(deps(box.mailbox, server, storeB, 'dev-b'), false)).toBe('restored');
    expect(box.prefs.size).toBe(0);
  });

  it('the last device keeps the original when it was the one that saved it', async () => {
    const original = { [ALERT_ENABLED_PREF]: 'FALSE', [ALERT_ADDRESS_PREF]: 'me@example.test' };
    const box = fakeMailbox(original);
    const { server } = fakeServer();
    const storeA = memoryStore();
    const storeB = memoryStore();
    await syncMailAlert(deps(box.mailbox, server, storeA, 'dev-a'), true);
    await syncMailAlert(deps(box.mailbox, server, storeB, 'dev-b'), true);
    expect(await syncMailAlert(deps(box.mailbox, server, storeB, 'dev-b'), false)).toBe('left');
    expect(await syncMailAlert(deps(box.mailbox, server, storeA, 'dev-a'), false)).toBe('restored');
    expect(Object.fromEntries(box.prefs)).toEqual(original);
  });

  it('never touches an alert the user pointed elsewhere since', async () => {
    const box = fakeMailbox({});
    const { server } = fakeServer();
    const store = memoryStore();
    await syncMailAlert(deps(box.mailbox, server, store), true);
    box.prefs.set(ALERT_ADDRESS_PREF, 'elsewhere@example.test');
    const writes = box.writes.length;
    expect(await syncMailAlert(deps(box.mailbox, server, store), false)).toBe('unchanged');
    expect(box.writes).toHaveLength(writes);
    expect(box.prefs.get(ALERT_ADDRESS_PREF)).toBe('elsewhere@example.test');
    expect(readAlertRecord(USER, store)).toBeNull();
  });

  it('a stale Canari address is not saved as the original', async () => {
    const stale = alertAddress('b'.repeat(32), DOMAIN);
    const box = fakeMailbox({ [ALERT_ENABLED_PREF]: 'TRUE', [ALERT_ADDRESS_PREF]: stale });
    const { server } = fakeServer();
    const store = memoryStore();
    expect(await syncMailAlert(deps(box.mailbox, server, store), true)).toBe('configured');
    expect(readAlertRecord(USER, store)?.saved).toEqual({ enabled: '', address: '' });
  });

  it('repairs an orphan of Canari shape, only when the server says nobody listens', async () => {
    const orphan = alertAddress('c'.repeat(32), DOMAIN);
    const box = fakeMailbox({ [ALERT_ENABLED_PREF]: 'TRUE', [ALERT_ADDRESS_PREF]: orphan });
    const { server } = fakeServer();
    expect(await syncMailAlert(deps(box.mailbox, server, memoryStore()), false)).toBe('repaired');
    expect(box.prefs.size).toBe(0);
  });

  it('leaves a live alert of another device alone', async () => {
    const box = fakeMailbox({});
    const { server } = fakeServer();
    await syncMailAlert(deps(box.mailbox, server, memoryStore(), 'dev-a'), true);
    const writes = box.writes.length;
    expect(await syncMailAlert(deps(box.mailbox, server, memoryStore(), 'dev-b'), false)).toBe(
      'unchanged'
    );
    expect(box.writes).toHaveLength(writes);
  });

  it('with mail_push none: nothing is configured, and an existing record restores', async () => {
    const original = { [ALERT_ADDRESS_PREF]: 'me@example.test' };
    const box = fakeMailbox(original);
    const fake = fakeServer();
    const store = memoryStore();
    await syncMailAlert(deps(box.mailbox, fake.server, store), true);
    fake.server.mode = 'none';
    expect(await syncMailAlert(deps(box.mailbox, fake.server, store), true)).toBe('off');
    expect(await syncMailAlert(deps(box.mailbox, fake.server, store), false)).toBe('restored');
    expect(Object.fromEntries(box.prefs)).toEqual(original);
  });

  it('an estate without an alert domain configures nothing', async () => {
    const box = fakeMailbox({});
    const { server } = fakeServer('cloudflare', null);
    expect(await syncMailAlert(deps(box.mailbox, server, memoryStore()), true)).toBe(
      'unconfigured'
    );
    expect(box.writes).toHaveLength(0);
  });

  it('no device id: nothing is read or written', async () => {
    const box = fakeMailbox({});
    const { server } = fakeServer();
    const d = { ...deps(box.mailbox, server, memoryStore()), deviceId: null };
    expect(await syncMailAlert(d, true)).toBe('no_device');
    expect(box.mailbox.call).not.toHaveBeenCalled();
  });

  it('a failed write takes the subscription back and keeps the original', async () => {
    const box = fakeMailbox({ [ALERT_ADDRESS_PREF]: 'me@example.test' });
    const { server, devices } = fakeServer();
    const store = memoryStore();
    box.failNextWrites();
    await expect(syncMailAlert(deps(box.mailbox, server, store), true)).rejects.toThrow(
      'write refused'
    );
    expect(devices.size).toBe(0);
    expect(readAlertRecord(USER, store)).toEqual({
      v: 1,
      subscribed: false,
      saved: { enabled: '', address: 'me@example.test' },
    });
  });

  it('an unreadable record is ignored', () => {
    const store = memoryStore();
    store.setItem(ACCOUNT_KEY.mailAlert(USER), '{"v":2}');
    expect(readAlertRecord(USER, store)).toBeNull();
    store.setItem(ACCOUNT_KEY.mailAlert(USER), 'not json');
    expect(readAlertRecord(USER, store)).toBeNull();
  });
});

describe('httpMailAlertServer', () => {
  const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('posts to the delivery routes', async () => {
    const fetcher = vi.fn(async () => answer(200, { remaining: 0 }));
    await httpMailAlertServer(fetcher).unsubscribe(DEVICE);
    expect(fetcher).toHaveBeenCalledWith('/api/mls/mail-alert/unsubscribe', { deviceId: DEVICE });
  });

  it.each([
    ['mail_push_off', 'off'],
    ['mail_alert_unconfigured', 'unconfigured'],
    ['push_not_registered', 'not_registered'],
    ['something_else', 'refused'],
  ])('types the refusal %s as %s', async (error, kind) => {
    const server = httpMailAlertServer(async () => answer(409, { error }));
    await expect(server.subscribe(DEVICE, 'a'.repeat(32))).rejects.toMatchObject({
      kind,
      status: 409,
    });
  });

  it('a refusal with no JSON body is refused', async () => {
    const server = httpMailAlertServer(async () => new Response('oops', { status: 502 }));
    await expect(server.state(DEVICE, null)).rejects.toBeInstanceOf(MailAlertServerError);
  });
});
