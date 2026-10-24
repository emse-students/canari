/**
 * MAKES A REQUEST LAND AND ITS ANSWER VANISH - the response-stage fault atom, over CDP `Fetch`.
 *
 * ## Why it exists (R3 of the 1.4.1 campaign, 2026-10-24)
 *
 * Commit settlement (#2269) exists for ONE case: a commit the server ACCEPTED whose answer the
 * client never read. The client must keep its stage, resubmit the same bytes and be told
 * `duplicate`. `archive/net.mjs` cannot make that case - `cut()` refuses a request BEFORE it leaves
 * and `throttleUpload()` only slows it - so before this file no tool here could put a commit in the
 * server's log and none in the client's hands. `Fetch` can: a request paused at the RESPONSE stage
 * has already been answered by the server, and the page sees only what this module then says.
 *
 * ## The modes, and WHERE each acts - the stage is part of the mode, never implied
 *
 * | mode            | stage    | the server ran it? | what the page sees                           |
 * | --------------- | -------- | ------------------ | -------------------------------------------- |
 * | `lose-answer`   | response | YES                | a transport failure (`failRequest`)          |
 * | `status N`      | response | YES                | status N, empty body, the real answer dropped |
 * | `status-unsent N` | request | NO                | status N; the server never saw the request   |
 * | `delay MS`      | response | YES                | the real answer, MS later                    |
 * | `hold`          | request  | NOT YET            | nothing, until `release()` sends it / `fail()` |
 * | `hold-answer`   | response | YES                | nothing, until `release()` delivers / `fail()` |
 *
 * `hold` is the one for "two members commit at the same epoch, released together" (CC-*): both
 * requests are stopped BEFORE the server, and `Promise.all([a.release(), b.release()])` lets them go
 * at once. `hold-answer` is for "the request never answers" (DUP-6): the server has acted.
 *
 * Every rule takes a count: `once` (1), `xN`, or unlimited. A request the rule no longer applies to
 * is continued untouched, so a `status 401 once` refuses the first commit and lets the retry through.
 *
 * ## It ends on facts, and it RECORDS what it did
 *
 * Every action is a record - CDP `requestId` and `networkId`, method, URL, the REAL status the
 * server gave (response stage) and what was done instead, ISO timestamps - so a row can join it to
 * the server's own log line for the same request. `awaitFired` and `awaitHeld` wait for CDP to say
 * the fault happened, never for a clock. `report()` names every rule that NEVER fired: a fault that
 * never fired is not a fault that was tested, and a row should record that as VACUOUS.
 *
 * ## What it cannot see
 *
 * `Fetch` on a PAGE session intercepts that page's requests. A request made by a SERVICE WORKER or
 * a worker that is its own CDP target is not the page's and is not paused; `archive/fault-live-
 * selftest.mjs` measures what a dedicated worker's fetch does on the Chrome that runs it.
 *
 * A LIBRARY, NOT A CLI: a fault lives exactly as long as the connection that armed it, so it belongs
 * inside the row that needs it (the same shape as `archive/net.mjs`).
 *
 *   const f = await armFault(cx, [{ match: '/api/mls/commit', method: 'POST', fault: 'lose-answer once' }]);
 *   ... act ...
 *   await f.awaitFired(0);
 *   const { records, vacuous } = await f.disarm();
 */

/** The modes and the Fetch stage each acts at. */
export const MODES = {
  'lose-answer': { stage: 'Response', arg: null },
  status: { stage: 'Response', arg: 'status' },
  'status-unsent': { stage: 'Request', arg: 'status' },
  delay: { stage: 'Response', arg: 'ms' },
  hold: { stage: 'Request', arg: null },
  'hold-answer': { stage: 'Response', arg: null },
};

/**
 * Parses `'<mode> [arg] [once|xN]'`, e.g. `'status 401 once'`, `'delay 3000 x2'`, `'hold'`.
 *
 * @param {string} spec
 * @returns {{ mode: string, stage: 'Request'|'Response', status?: number, ms?: number, times: number }}
 */
export function parseFault(spec) {
  const words = String(spec).trim().split(/\s+/);
  const mode = words.shift();
  const def = MODES[mode];
  if (!def) throw new Error(`parseFault: unknown mode '${mode}' - one of ${Object.keys(MODES).join(', ')}`);
  const out = { mode, stage: def.stage, times: Infinity };
  if (def.arg) {
    const n = Number(words.shift());
    if (def.arg === 'status' && !(Number.isInteger(n) && n >= 100 && n <= 599))
      throw new Error(`parseFault: '${spec}' needs an HTTP status 100-599`);
    if (def.arg === 'ms' && !(Number.isInteger(n) && n >= 0)) throw new Error(`parseFault: '${spec}' needs a delay in ms`);
    out[def.arg] = n;
  }
  const count = words.shift();
  if (count === 'once') out.times = 1;
  else if (count && /^x[1-9]\d*$/.test(count)) out.times = Number(count.slice(1));
  else if (count !== undefined) throw new Error(`parseFault: '${spec}' - '${count}' is not 'once' or 'xN'`);
  if (words.length) throw new Error(`parseFault: '${spec}' has trailing words: ${words.join(' ')}`);
  return out;
}

/**
 * The CDP `urlPattern` that lets Chrome pause ONLY candidates for a rule: a substring becomes
 * `*<substring>*` with the wildcard characters escaped; a RegExp cannot be expressed and pauses all,
 * the rule then deciding in `ruleMatches`.
 *
 * @param {string | RegExp} match
 */
export const toUrlPattern = (match) => (match instanceof RegExp ? '*' : `*${String(match).replace(/[\\*?]/g, (c) => `\\${c}`)}*`);

/** Whether a rule applies to this request (URL substring or RegExp, and the method when given). */
export function ruleMatches(rule, { url, method }) {
  const urlOk = rule.match instanceof RegExp ? rule.match.test(url) : url.includes(rule.match);
  return urlOk && (!rule.method || rule.method.toUpperCase() === String(method).toUpperCase());
}

/**
 * Normalises the rules a caller hands in: `{ match, method?, fault: '<spec>' }`.
 *
 * @param {Array<{match: string|RegExp, method?: string, fault: string}>} rules
 */
export function compileRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) throw new Error('armFault: no rule given');
  return rules.map((r, index) => {
    if (!(typeof r.match === 'string' && r.match !== '') && !(r.match instanceof RegExp))
      throw new Error(`armFault: rule ${index} has no 'match'`);
    return { index, match: r.match, method: r.method ?? null, ...parseFault(r.fault), spec: r.fault, fired: 0 };
  });
}

/**
 * The rule this paused request is for, CLAIMED synchronously so two requests paused together can
 * never both take a `once`. Null means "continue it untouched".
 *
 * @param {ReturnType<typeof compileRules>} compiled
 * @param {{ url: string, method: string, stage: 'Request'|'Response' }} req
 */
export function claimRule(compiled, req) {
  const rule = compiled.find((r) => r.stage === req.stage && r.fired < r.times && ruleMatches(r, req));
  if (rule) rule.fired += 1;
  return rule ?? null;
}

/**
 * Arms the rules on one CDP connection and returns the handle.
 *
 * @param {{ send: Function, on: Function }} cx a connection from `cdp.mjs` `connect` / `chat.mjs` `client`
 * @param {Array<{match: string|RegExp, method?: string, fault: string}>} rules
 * @param {{ log?: (line: string) => void }} [opts]
 */
export async function armFault(cx, rules, { log = (l) => console.log(l) } = {}) {
  const compiled = compileRules(rules);
  log(`  [fault] arm ${compiled.map((r) => `#${r.index} ${r.method ?? '*'} ${r.match} -> ${r.spec}`).join('; ')}`);
  const records = [];
  /** Requests a `hold` / `hold-answer` stopped, in arrival order, not yet released or failed. */
  const held = [];
  const waiters = new Set();
  const wake = () => {
    for (const w of waiters) w(); // a waiter may delete itself: deleting the visited entry of a Set is safe
  };
  let armed = true;

  const answer = async (method, params, record) => {
    try {
      await cx.send(method, params);
      record.done = method.replace('Fetch.', '');
    } catch (e) {
      // The page navigated or closed under the pause - nothing left to answer. Recorded, not hidden.
      record.answerError = e instanceof Error ? e.message : String(e);
      log(`  [fault] ${method} for ${record.requestId} failed: ${record.answerError}`);
    }
    record.answeredAt = new Date().toISOString();
    wake();
  };

  const onPaused = (p) => {
    const stage = p.responseStatusCode !== undefined || p.responseErrorReason !== undefined ? 'Response' : 'Request';
    const req = { url: p.request?.url ?? '', method: p.request?.method ?? '', stage };
    const rule = armed ? claimRule(compiled, req) : null;
    if (!rule) {
      // NOT OURS, OR NO LONGER: every paused request MUST be answered or the page hangs on it.
      void cx.send('Fetch.continueRequest', { requestId: p.requestId }).catch((e) => log(`  [fault] continue ${p.requestId} failed: ${e.message}`));
      return;
    }
    const record = {
      rule: rule.index,
      fault: rule.spec,
      mode: rule.mode,
      stage,
      requestId: p.requestId,
      networkId: p.networkId ?? null,
      method: req.method,
      url: req.url,
      realStatus: p.responseStatusCode ?? null,
      realError: p.responseErrorReason ?? null,
      pausedAt: new Date().toISOString(),
    };
    records.push(record);
    log(`  [fault] #${rule.index} ${rule.mode} ${req.method} ${req.url} (real ${record.realStatus ?? record.realError ?? 'unsent'})`);
    switch (rule.mode) {
      case 'lose-answer':
        void answer('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionReset' }, record);
        break;
      case 'status':
      case 'status-unsent':
        record.gave = rule.status;
        void answer('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: rule.status, responseHeaders: [], body: '' }, record);
        break;
      case 'delay': {
        const t = setTimeout(() => void answer('Fetch.continueRequest', { requestId: p.requestId }, record), rule.ms);
        t.unref?.();
        break;
      }
      case 'hold':
      case 'hold-answer':
        held.push(record);
        break;
      default:
        throw new Error(`fault: no action for mode ${rule.mode}`);
    }
    // AFTER the action is in place: a waiter woken before `held.push` re-checks an empty list and is
    // never woken again (the live self-test's first run hung on exactly that).
    wake();
  };

  const unsubscribe = cx.on('Fetch.requestPaused', onPaused);
  const stages = [...new Set(compiled.map((r) => r.stage))];
  const patterns = [];
  for (const r of compiled) {
    const urlPattern = toUrlPattern(r.match);
    if (!patterns.some((x) => x.urlPattern === urlPattern && x.requestStage === r.stage)) patterns.push({ urlPattern, requestStage: r.stage });
  }
  await cx.send('Fetch.enable', { patterns });
  log(`  [fault] Fetch enabled at stage(s) ${stages.join('+')}`);

  /** Resolves when `predicate()` holds, re-checked on every fault event; rejects after `timeoutMs` naming it. */
  const awaitFact = (predicate, what, timeoutMs) =>
    new Promise((resolve, reject) => {
      if (predicate()) return resolve(true);
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`fault: ${what} never happened within ${timeoutMs} ms`));
      }, timeoutMs);
      const check = () => {
        if (!predicate()) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(true);
      };
      waiters.add(check);
    });

  const settleHeld = async (method, which) => {
    const all = held.splice(0);
    const take = which === undefined ? all : all.filter((r) => which(r));
    held.push(...all.filter((r) => !take.includes(r)));
    await Promise.all(
      take.map((r) =>
        method === 'release'
          ? answer('Fetch.continueRequest', { requestId: r.requestId }, r)
          : answer('Fetch.failRequest', { requestId: r.requestId, errorReason: 'ConnectionReset' }, r),
      ),
    );
    return take.length;
  };

  const report = () => ({
    rules: compiled.map((r) => ({ rule: r.index, fault: r.spec, match: String(r.match), method: r.method, fired: r.fired })),
    vacuous: compiled.filter((r) => r.fired === 0).map((r) => r.index),
  });

  return {
    records,
    /** How often rule `i` has acted. */
    fired: (i) => compiled[i].fired,
    /** Waits until rule `i` has acted `n` times (default 1). */
    awaitFired: (i, n = 1, timeoutMs = 30_000) => awaitFact(() => compiled[i].fired >= n, `rule #${i} firing ${n} time(s)`, timeoutMs),
    /** Waits until `n` requests are held. */
    awaitHeld: (n = 1, timeoutMs = 30_000) => awaitFact(() => held.length >= n, `${n} held request(s)`, timeoutMs),
    /** Requests currently held. */
    held: () => [...held],
    /** Lets the held requests go on (all, or those `which(record)` selects); resolves when CDP accepted each. */
    release: (which) => settleHeld('release', which),
    /** Fails the held requests as a transport failure. */
    fail: (which) => settleHeld('fail', which),
    /** Per-rule counts, and the rules that never fired - a VACUOUS fault. */
    report,
    /**
     * Releases anything still held, stops intercepting and returns the report with every record.
     * Idempotent. A row MUST call it (in a `finally`), or the page keeps waiting on held requests.
     */
    disarm: async () => {
      if (armed) {
        armed = false;
        const left = await settleHeld('release');
        if (left) log(`  [fault] disarm released ${left} request(s) still held`);
        await cx.send('Fetch.disable').catch((e) => log(`  [fault] Fetch.disable failed: ${e.message}`));
        unsubscribe();
        log('  [fault] disarmed');
      }
      return { ...report(), records };
    },
  };
}
