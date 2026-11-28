import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import {
  ALERT_CONTENT,
  ALERT_RULE_NAME,
  ALERT_SUBJECT,
  alertAddress,
  alertRule,
  httpMailAlertServer,
  isAlertRule,
  MailAlertServerError,
  newAlertToken,
  parseAlertAddress,
  readAlertRecord,
  syncMailAlert,
  type FilterRule,
  type MailAlertServer,
  type MailAlertServerState,
} from './mailAlert';
import { MailError } from './mailErrors';
import { parseFilterRules } from './zimbraParse';
import { getFilterRulesRequest, modifyFilterRulesRequest } from './zimbraRequests';

vi.mock('$lib/utils/Log', () => ({
  Log: { d: vi.fn(), i: vi.fn(), w: vi.fn(), e: vi.fn() },
}));

const DOMAIN = 'alerte.example.test';
const USER = 'u1';
const DEVICE = 'dev-a';

/** Two rules of the user's, in the shape Zimbra answers (one with fields Canari never writes). */
const USER_RULES: FilterRule[] = [
  {
    name: 'newsletters',
    active: true,
    filterTests: [
      {
        condition: 'anyof',
        headerTest: [
          { index: 0, header: 'subject', stringComparison: 'contains', value: '[news]' },
        ],
      },
    ],
    filterActions: [
      { actionFileInto: [{ index: 0, folderPath: 'News' }], actionStop: [{ index: 1 }] },
    ],
  },
  {
    name: 'forward-boss',
    active: false,
    filterTests: [{ condition: 'allof', addressTest: [{ index: 0, header: 'from', part: 'all' }] }],
    filterActions: [{ actionRedirect: [{ index: 0, a: 'me@example.test' }] }],
  },
];

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
 * A mailbox holding the account's filter rules as Zimbra would: `GetFilterRules` answers them in
 * order, `ModifyFilterRules` REPLACES them with what it is handed. Rules round-trip through JSON, so
 * an identity a test compares is a value, never a shared object.
 */
function fakeMailbox(initial: FilterRule[] = []) {
  let rules: FilterRule[] = structuredClone(initial);
  const writes: FilterRule[][] = [];
  let failWrite = false;
  const call = vi.fn(async (body: Record<string, any>) => {
    if (body.GetFilterRulesRequest) {
      return { GetFilterRulesResponse: { filterRules: [{ filterRule: structuredClone(rules) }] } };
    }
    if (body.ModifyFilterRulesRequest) {
      if (failWrite) throw new Error('write refused');
      rules = structuredClone(body.ModifyFilterRulesRequest.filterRules[0].filterRule);
      writes.push(rules);
      return { ModifyFilterRulesResponse: {} };
    }
    throw new Error('unexpected request');
  });
  return {
    mailbox: { call } as any,
    rules: () => rules,
    set(next: FilterRule[]) {
      rules = structuredClone(next);
    },
    writes,
    failNextWrites() {
      failWrite = true;
    },
  };
}

/** The token Canari's rule names now, or `null`. */
function ruleToken(rules: FilterRule[]): string | null {
  const ours = rules.find(isAlertRule) as any;
  return ours ? parseAlertAddress(ours.filterActions[0].actionNotify[0].a)!.token : null;
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

describe("Canari's rule", () => {
  it('is the measured shape: every mail, a fixed notice with no body, kept, never stopped', () => {
    const address = alertAddress('a'.repeat(32), DOMAIN);
    const rule = alertRule(address) as any;
    expect(rule.name).toBe(ALERT_RULE_NAME);
    expect(rule.active).toBe(true);
    expect(rule.filterTests[0].condition).toBe('anyof');
    expect(rule.filterActions[0].actionNotify).toEqual([
      {
        index: 0,
        a: address,
        su: ALERT_SUBJECT,
        content: [{ _content: ALERT_CONTENT }],
        maxBodySize: 0,
      },
    ]);
    expect(rule.filterActions[0].actionKeep).toEqual([{ index: 1 }]);
    expect(rule.filterActions[0].actionStop).toBeUndefined();
    // `content` as a bare string is service.PARSE_ERROR on Partage (measured).
    expect(Array.isArray(rule.filterActions[0].actionNotify[0].content)).toBe(true);
  });

  it('is recognised by our name AND an address of our shape, never by one alone', () => {
    const address = alertAddress('a'.repeat(32), DOMAIN);
    expect(isAlertRule(alertRule(address))).toBe(true);
    expect(isAlertRule({ ...alertRule(address), name: 'my-alert' })).toBe(false);
    expect(isAlertRule(alertRule('me@example.test'))).toBe(false);
    for (const rule of USER_RULES) expect(isAlertRule(rule)).toBe(false);
  });
});

describe('the Zimbra filter-rule requests', () => {
  it('reads the rules in order, and refuses an answer without its rule list', () => {
    expect(getFilterRulesRequest()).toEqual({ GetFilterRulesRequest: { _jsns: 'urn:zimbraMail' } });
    expect(
      parseFilterRules({ GetFilterRulesResponse: { filterRules: [{ filterRule: USER_RULES }] } })
    ).toEqual(USER_RULES);
    expect(parseFilterRules({ GetFilterRulesResponse: { filterRules: [{}] } })).toEqual([]);
    expect(() => parseFilterRules({ GetFilterRulesResponse: {} })).toThrow(MailError);
  });

  it('writes the whole list in the measured shape', () => {
    expect(modifyFilterRulesRequest(USER_RULES)).toEqual({
      ModifyFilterRulesRequest: {
        _jsns: 'urn:zimbraMail',
        filterRules: [{ filterRule: USER_RULES }],
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

  it("puts Canari's rule FIRST, keeps the user's verbatim, and removes only ours", async () => {
    const box = fakeMailbox(USER_RULES);
    const { server, token } = fakeServer();
    const store = memoryStore();

    expect(await syncMailAlert(deps(box.mailbox, server, store), true)).toBe('configured');
    expect(isAlertRule(box.rules()[0])).toBe(true);
    expect(ruleToken(box.rules())).toBe(token());
    expect(box.rules().slice(1)).toEqual(USER_RULES);
    expect(readAlertRecord(USER, store)).toEqual({ v: 1, subscribed: true });

    expect(await syncMailAlert(deps(box.mailbox, server, store), false)).toBe('removed');
    expect(box.rules()).toEqual(USER_RULES);
    expect(readAlertRecord(USER, store)).toBeNull();
    expect(token()).toBeNull();
  });

  it('an account with no rule gets ours alone, and is left with none', async () => {
    const box = fakeMailbox([]);
    const { server } = fakeServer();
    const store = memoryStore();
    await syncMailAlert(deps(box.mailbox, server, store), true);
    expect(box.rules()).toHaveLength(1);
    await syncMailAlert(deps(box.mailbox, server, store), false);
    expect(box.rules()).toEqual([]);
  });

  it('is idempotent: a second sync writes nothing', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server } = fakeServer();
    const store = memoryStore();
    await syncMailAlert(deps(box.mailbox, server, store), true);
    expect(await syncMailAlert(deps(box.mailbox, server, store), true)).toBe('unchanged');
    expect(box.writes).toHaveLength(1);
  });

  it('a second device joins the token read back from the rule, which stays until the last leaves', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server, devices } = fakeServer();
    const storeA = memoryStore();
    const storeB = memoryStore();

    await syncMailAlert(deps(box.mailbox, server, storeA, 'dev-a'), true);
    expect(await syncMailAlert(deps(box.mailbox, server, storeB, 'dev-b'), true)).toBe('joined');
    expect(devices.size).toBe(2);
    expect(box.writes).toHaveLength(1);

    expect(await syncMailAlert(deps(box.mailbox, server, storeA, 'dev-a'), false)).toBe('left');
    expect(box.rules().some(isAlertRule)).toBe(true);
    expect(await syncMailAlert(deps(box.mailbox, server, storeB, 'dev-b'), false)).toBe('removed');
    expect(box.rules()).toEqual(USER_RULES);
  });

  it('a rule the user changed or added meanwhile is written back as it now is', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server } = fakeServer();
    const store = memoryStore();
    await syncMailAlert(deps(box.mailbox, server, store), true);
    const added: FilterRule = { ...USER_RULES[0], name: 'added-later' };
    box.set([added, ...box.rules()]);
    await syncMailAlert(deps(box.mailbox, server, store), false);
    expect(box.rules()).toEqual([added, ...USER_RULES]);
  });

  it('a rule the user disabled is replaced by an active one when the push is wanted', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server } = fakeServer();
    const store = memoryStore();
    await syncMailAlert(deps(box.mailbox, server, store), true);
    box.set(box.rules().map((r) => (isAlertRule(r) ? { ...r, active: false } : r)));
    expect(await syncMailAlert(deps(box.mailbox, server, store), true)).toBe('configured');
    expect(box.rules().filter(isAlertRule)).toHaveLength(1);
    expect(box.rules()[0].active).toBe(true);
    expect(box.rules().slice(1)).toEqual(USER_RULES);
  });

  it('a stale rule of ours is replaced, never duplicated', async () => {
    const stale = alertRule(alertAddress('b'.repeat(32), DOMAIN));
    const box = fakeMailbox([...USER_RULES, stale]);
    const { server, token } = fakeServer();
    expect(await syncMailAlert(deps(box.mailbox, server, memoryStore()), true)).toBe('configured');
    expect(box.rules().filter(isAlertRule)).toHaveLength(1);
    expect(ruleToken(box.rules())).toBe(token());
    expect(box.rules().slice(1)).toEqual(USER_RULES);
  });

  it("a rule of our name pointing elsewhere is the user's: never touched", async () => {
    const theirs = alertRule('me@example.test');
    const box = fakeMailbox([theirs]);
    const { server } = fakeServer();
    const store = memoryStore();
    await syncMailAlert(deps(box.mailbox, server, store), true);
    expect(box.rules().slice(1)).toEqual([theirs]);
    await syncMailAlert(deps(box.mailbox, server, store), false);
    expect(box.rules()).toEqual([theirs]);
  });

  it('repairs an orphan rule of ours, only when the server says nobody listens', async () => {
    const orphan = alertRule(alertAddress('c'.repeat(32), DOMAIN));
    const box = fakeMailbox([orphan, ...USER_RULES]);
    const { server } = fakeServer();
    expect(await syncMailAlert(deps(box.mailbox, server, memoryStore()), false)).toBe('repaired');
    expect(box.rules()).toEqual(USER_RULES);
  });

  it('leaves a live rule of another device alone', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server } = fakeServer();
    await syncMailAlert(deps(box.mailbox, server, memoryStore(), 'dev-a'), true);
    const writes = box.writes.length;
    expect(await syncMailAlert(deps(box.mailbox, server, memoryStore(), 'dev-b'), false)).toBe(
      'unchanged'
    );
    expect(box.writes).toHaveLength(writes);
  });

  it('with mail_push none: nothing is configured, and a subscribed device removes its rule', async () => {
    const box = fakeMailbox(USER_RULES);
    const fake = fakeServer();
    const store = memoryStore();
    await syncMailAlert(deps(box.mailbox, fake.server, store), true);
    fake.server.mode = 'none';
    expect(await syncMailAlert(deps(box.mailbox, fake.server, store), true)).toBe('off');
    expect(await syncMailAlert(deps(box.mailbox, fake.server, store), false)).toBe('removed');
    expect(box.rules()).toEqual(USER_RULES);
  });

  it('an estate without an alert domain configures nothing', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server } = fakeServer('cloudflare', null);
    expect(await syncMailAlert(deps(box.mailbox, server, memoryStore()), true)).toBe(
      'unconfigured'
    );
    expect(box.writes).toHaveLength(0);
  });

  it('no device id: nothing is read or written', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server } = fakeServer();
    const d = { ...deps(box.mailbox, server, memoryStore()), deviceId: null };
    expect(await syncMailAlert(d, true)).toBe('no_device');
    expect(box.mailbox.call).not.toHaveBeenCalled();
  });

  it('a failed write takes the subscription back and leaves the rules as they were', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server, devices } = fakeServer();
    const store = memoryStore();
    box.failNextWrites();
    await expect(syncMailAlert(deps(box.mailbox, server, store), true)).rejects.toThrow(
      'write refused'
    );
    expect(devices.size).toBe(0);
    expect(box.rules()).toEqual(USER_RULES);
    expect(readAlertRecord(USER, store)).toEqual({ v: 1, subscribed: false });
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
