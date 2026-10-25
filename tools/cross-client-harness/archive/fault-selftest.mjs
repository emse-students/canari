/**
 * THE RESPONSE-STAGE FAULT ATOM DECIDES WHAT IT SHOULD, AGAINST A FAKE CDP CONNECTION.
 *
 * `fault.mjs` answers every request Chrome pauses; a decision taken wrongly either faults the wrong
 * request or - worse - leaves one paused for ever, which hangs the page and reads as an application
 * stall. This gate drives the real `armFault` with a stub connection: the parser, the URL pattern,
 * once/xN accounting under requests paused together, the answer each mode sends, and that a request
 * no rule claims is continued. What Chrome itself does with those answers is
 * `fault-live-selftest.mjs` (a headless Chrome and a throwaway server, no estate).
 *
 *   bun archive/fault-selftest.mjs
 */
import { armFault, claimRule, compileRules, fulfilBody, parseFault, ruleMatches, toUrlPattern } from '../fault.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

// ── the parser: the stage is part of the mode ───────────────────────────────────────────────────
ok('lose-answer acts at the RESPONSE stage, unlimited', parseFault('lose-answer').stage === 'Response' && parseFault('lose-answer').times === Infinity);
ok('status N acts after the server ran', parseFault('status 503').stage === 'Response' && parseFault('status 503').status === 503);
ok('status-unsent N never reaches the server', parseFault('status-unsent 503').stage === 'Request');
ok('hold stops the request BEFORE the server', parseFault('hold').stage === 'Request');
ok('hold-answer stops the answer AFTER it', parseFault('hold-answer').stage === 'Response');
ok("'status 401 once' is a one-shot", parseFault('status 401 once').times === 1);
ok("'delay 3000 x2' is two", parseFault('delay 3000 x2').ms === 3000 && parseFault('delay 3000 x2').times === 2);
ok('an unknown mode is refused', throws(() => parseFault('drop')));
ok('a status out of range is refused', throws(() => parseFault('status 999')));
ok('a status without its number is refused', throws(() => parseFault('status once')));
ok('a bad count is refused', throws(() => parseFault('hold twice')));
ok('trailing words are refused, not ignored', throws(() => parseFault('lose-answer once please')));
ok('a rule with no match is refused', throws(() => compileRules([{ fault: 'hold' }])));
ok('no rule at all is refused', throws(() => compileRules([])));

// ── matching ────────────────────────────────────────────────────────────────────────────────────
ok('a substring becomes a CDP wildcard', toUrlPattern('/api/mls/commit') === '*/api/mls/commit*');
ok('wildcard characters in it are escaped', toUrlPattern('/a*b?c') === '*/a\\*b\\?c*');
ok('a RegExp pauses everything and decides in JS', toUrlPattern(/commit$/) === '*');
ok('method is compared case-insensitively', ruleMatches({ match: '/x', method: 'post' }, { url: 'http://h/x', method: 'POST' }));
ok('a different method does not match', !ruleMatches({ match: '/x', method: 'POST' }, { url: 'http://h/x', method: 'GET' }));
ok('a RegExp rule matches by test', ruleMatches({ match: /\/x$/ }, { url: 'http://h/x', method: 'GET' }));

// ── accounting: a once is taken once, even by two requests paused together ──────────────────────
{
  const rules = compileRules([{ match: '/c', fault: 'status 401 once' }]);
  const a = claimRule(rules, { url: 'http://h/c', method: 'POST', stage: 'Response' });
  const b = claimRule(rules, { url: 'http://h/c', method: 'POST', stage: 'Response' });
  ok('the first request takes the once', a?.index === 0);
  ok('the second is NOT faulted', b === null);
  ok('a request at the other stage is never claimed', claimRule(compileRules([{ match: '/c', fault: 'hold' }]), { url: 'http://h/c', method: 'POST', stage: 'Response' }) === null);
}

// ── armFault against a stub connection ──────────────────────────────────────────────────────────
const fakeCx = () => {
  const sent = [];
  let handler = null;
  return {
    sent,
    send: async (method, params) => {
      sent.push({ method, params });
      return {};
    },
    on: (method, fn) => {
      if (method === 'Fetch.requestPaused') handler = fn;
      return () => (handler = null);
    },
    pause: (p) => handler?.(p),
    hasHandler: () => handler !== null,
  };
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const quiet = () => {};

{
  const cx = fakeCx();
  const f = await armFault(
    cx,
    [
      { match: '/api/commit', method: 'POST', fault: 'lose-answer once' },
      { match: '/api/other', fault: 'status-unsent 503' },
      { match: '/api/held', fault: 'hold' },
      { match: '/never', fault: 'status 500' },
    ],
    { log: quiet },
  );
  const enable = cx.sent.find((s) => s.method === 'Fetch.enable');
  ok('Fetch is enabled with one pattern per rule, each at its own stage', enable?.params.patterns.length === 4 && enable.params.patterns.some((p) => p.requestStage === 'Request') && enable.params.patterns.some((p) => p.requestStage === 'Response'));

  cx.pause({ requestId: 'r1', networkId: 'n1', request: { url: 'https://h/api/commit', method: 'POST' }, responseStatusCode: 200 });
  cx.pause({ requestId: 'r2', request: { url: 'https://h/api/commit', method: 'POST' }, responseStatusCode: 200 });
  cx.pause({ requestId: 'r3', request: { url: 'https://h/api/other', method: 'GET' } });
  cx.pause({ requestId: 'r4', request: { url: 'https://h/api/held', method: 'POST' } });
  cx.pause({ requestId: 'r5', request: { url: 'https://h/unrelated', method: 'GET' } });
  await tick();
  const answerFor = (id) => cx.sent.filter((s) => s.params?.requestId === id).map((s) => s.method);
  ok('lose-answer FAILS the answer of the request that reached the server', answerFor('r1').join() === 'Fetch.failRequest');
  ok('and records the real status it discarded, with the ids to join on', f.records[0].realStatus === 200 && f.records[0].networkId === 'n1' && f.records[0].stage === 'Response');
  ok('its once is spent: the resubmission is continued untouched', answerFor('r2').join() === 'Fetch.continueRequest');
  ok('status-unsent fulfills at the request stage with the status', answerFor('r3').join() === 'Fetch.fulfillRequest' && cx.sent.find((s) => s.params?.requestId === 'r3').params.responseCode === 503);
  ok('hold answers NOTHING until released', answerFor('r4').length === 0 && f.held().length === 1);
  ok('a request no rule names is continued', answerFor('r5').join() === 'Fetch.continueRequest');
  await f.awaitHeld(1, 100);
  ok('release sends the held request on', (await f.release()) === 1 && answerFor('r4').join() === 'Fetch.continueRequest' && f.held().length === 0);
  const rep = await f.disarm();
  ok('disarm disables Fetch and unsubscribes', cx.sent.at(-1).method === 'Fetch.disable' && !cx.hasHandler());
  ok('the rule that never fired is reported VACUOUS', rep.vacuous.join() === '3');
  ok('and every action is in the records', rep.records.length === 3 && rep.rules[0].fired === 1);
  ok('disarm is idempotent', (await f.disarm()).records.length === 3 && cx.sent.filter((s) => s.method === 'Fetch.disable').length === 1);
}

{
  const cx = fakeCx();
  const f = await armFault(cx, [{ match: '/h', fault: 'hold-answer x2' }], { log: quiet });
  cx.pause({ requestId: 'a', request: { url: 'https://h/h', method: 'POST' }, responseStatusCode: 201 });
  cx.pause({ requestId: 'b', request: { url: 'https://h/h', method: 'POST' }, responseStatusCode: 201 });
  await tick();
  ok('fail() of one selected held request fails only that one', (await f.fail((r) => r.requestId === 'a')) === 1 && f.held().map((r) => r.requestId).join() === 'b');
  await f.disarm();
  ok('disarm releases what is still held rather than leaving it paused', cx.sent.some((s) => s.method === 'Fetch.continueRequest' && s.params.requestId === 'b'));
  ok('awaitFired rejects, naming the fact, when it never happens', await f.awaitFired(0, 5, 20).then(() => false, (e) => /rule #0 firing 5/.test(e.message)));
}

// ── a status answer can carry the body the client classifies by (DUP-4's 409) ───────────────────
{
  ok('a body on a mode that sends none is refused', throws(() => compileRules([{ match: '/c', fault: 'lose-answer once', body: { code: 'X' } }])));
  ok('no body is an empty one, with no header', fulfilBody(undefined).body === '' && fulfilBody(undefined).responseHeaders.length === 0);
  const seat = { code: 'SEAT_CLAIM_OVERTAKEN', message: 'this commit is not accepted' };
  const enc = fulfilBody(seat);
  ok('an object is sent as base64 JSON', JSON.parse(Buffer.from(enc.body, 'base64').toString('utf8')).code === 'SEAT_CLAIM_OVERTAKEN');
  ok('with a JSON content type', (enc.responseHeaders.find((h) => h.name === 'Content-Type')?.value ?? '').startsWith('application/json'));
  ok('a string is sent as text', fulfilBody('nope').responseHeaders[0].value.startsWith('text/plain'));
  const cx = fakeCx();
  const f = await armFault(cx, [{ match: '/c', fault: 'status 409 once', body: seat }], { log: quiet });
  cx.pause({ requestId: 'z', request: { url: 'https://h/c', method: 'POST' }, responseStatusCode: 201 });
  await tick();
  const sent = cx.sent.find((s) => s.method === 'Fetch.fulfillRequest' && s.params.requestId === 'z');
  ok('status 409 fulfils with the body and its header', sent?.params.responseCode === 409 && sent.params.body === enc.body && sent.params.responseHeaders.length === 1);
  ok('and records the body it gave', JSON.parse(f.records[0].gaveBody).code === 'SEAT_CLAIM_OVERTAKEN');
  await f.disarm();
}

// ── rewrite and rewrite-url: the GAP rows' tools ───────────────────────────────────────────────────
{
  ok('a rewrite without its transform is refused', throws(() => compileRules([{ match: '/m', fault: 'rewrite' }])));
  ok('a rewrite-url without its url function is refused', throws(() => compileRules([{ match: '/m', fault: 'rewrite-url' }])));
  ok('a transform on a mode that never calls it is refused', throws(() => compileRules([{ match: '/m', fault: 'hold', transform: (t) => t }])));
  ok('rewrite acts after the server, rewrite-url before it', parseFault('rewrite').stage === 'Response' && parseFault('rewrite-url').stage === 'Request');

  // A connection whose getResponseBody answers with a JSON page, base64-encoded as Chrome may send it.
  const page = JSON.stringify([{ id: 'c1', isCommit: true }, { id: 'a1', isCommit: false }]);
  const cx = fakeCx();
  const realSend = cx.send;
  cx.send = async (method, params) => {
    if (method === 'Fetch.getResponseBody') {
      cx.sent.push({ method, params });
      return params.requestId === 'broken' ? Promise.reject(new Error('No resource with given identifier')) : { body: Buffer.from(page).toString('base64'), base64Encoded: true };
    }
    return realSend(method, params);
  };
  const f = await armFault(
    cx,
    [
      { match: '/api/mls/messages/', method: 'GET', fault: 'rewrite x2', transform: (t) => JSON.stringify(JSON.parse(t).filter((r) => !r.isCommit)) },
      { match: '/api/mls/messages/', method: 'GET', fault: 'rewrite-url once', url: (u) => `${u}&after=X` },
    ],
    { log: quiet },
  );
  cx.pause({ requestId: 'p1', request: { url: 'https://h/api/mls/messages/u/d?limit=500', method: 'GET' }, responseStatusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Content-Length', value: '99' }] });
  await tick();
  await tick();
  const fill = cx.sent.find((s) => s.method === 'Fetch.fulfillRequest' && s.params.requestId === 'p1');
  const body = fill ? JSON.parse(Buffer.from(fill.params.body, 'base64').toString('utf8')) : null;
  ok('rewrite answers with the transformed body', body?.length === 1 && body[0].id === 'a1');
  ok('... under the REAL status, with the stale length dropped', fill?.params.responseCode === 200 && fill.params.responseHeaders.length === 1 && fill.params.responseHeaders[0].name === 'Content-Type');
  ok('... and records that it changed something', f.records[0].changed === true && f.records[0].bytesAfter < f.records[0].bytesBefore);
  cx.pause({ requestId: 'broken', request: { url: 'https://h/api/mls/messages/u/d', method: 'GET' }, responseStatusCode: 200 });
  await tick();
  await tick();
  ok('an unreadable body sends the real answer on, and says so', cx.sent.some((s) => s.method === 'Fetch.continueRequest' && s.params.requestId === 'broken') && /unreadable/.test(f.records[1].rewriteError ?? ''));
  cx.pause({ requestId: 'u1', request: { url: 'https://h/api/mls/messages/u/d?limit=500', method: 'GET' } });
  await tick();
  const cont = cx.sent.find((s) => s.method === 'Fetch.continueRequest' && s.params.requestId === 'u1');
  ok('rewrite-url continues the request at the new url', cont?.params.url === 'https://h/api/mls/messages/u/d?limit=500&after=X' && f.records[2].changed === true);
  cx.pause({ requestId: 'u2', request: { url: 'https://h/api/mls/messages/u/d?limit=500', method: 'GET' } });
  await tick();
  ok('its once spent, the next request goes on untouched', cx.sent.find((s) => s.params?.requestId === 'u2')?.params.url === undefined);
  await f.disarm();
}

console.log(
  failures
    ? `[fault] ${failures} FAILURE(S) - the fault atom decides wrongly or leaves a request paused`
    : '[fault] clean - every mode answers at its stage, a once is taken once, nothing is left paused',
);
process.exit(failures ? 1 : 0);
