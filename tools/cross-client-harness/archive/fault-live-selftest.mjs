/**
 * WHAT CHROME DOES WITH EACH FAULT, MEASURED AGAINST A SERVER THAT COUNTS - AND NO ESTATE AT ALL.
 *
 * `fault-selftest.mjs` proves `fault.mjs` SENDS the right CDP answer; this proves the answer has the
 * effect the campaign's rows rely on: that `lose-answer` lets the request REACH the server while the
 * page sees a transport failure, that `status-unsent` never reaches it, that a `hold` keeps both the
 * server and the page waiting until `release()`. Each is asserted from both ends - the server's own
 * count and what the page's `fetch` resolved to.
 *
 * NOTHING HERE TOUCHES AN ESTATE OR A RIG PROFILE: a throwaway `Bun.serve` on 127.0.0.1 and a
 * headless Chrome on a TEMPORARY profile and its own debugging port (9298, never W1/W2/W3's). It
 * needs Chrome installed, so it is in `make test-harness-device`, not the CI gate.
 *
 * It also MEASURES, without asserting, whether a dedicated Worker's fetch is paused by `Fetch` on
 * the page session - the app runs work in workers, and a row must know whether its fault reaches
 * one.
 *
 *   bun archive/fault-live-selftest.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, evaluate, listTargets, until } from '../cdp.mjs';
import { armFault } from '../fault.mjs';

const PORT = 9298;
const CHROME =
  process.env.CHROME ??
  ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p));
if (!CHROME) {
  console.log('[fault-live] no Chrome found (set CHROME) - cannot run');
  process.exit(1);
}

let failures = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};

// ── the server: counts every request by path ────────────────────────────────────────────────────
const seen = new Map();
const count = (path) => seen.get(path) ?? 0;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    seen.set(path, count(path) + 1);
    if (path === '/') return new Response('<!doctype html><title>fault</title>', { headers: { 'content-type': 'text/html' } });
    if (path === '/worker.js')
      return new Response("onmessage = async (e) => { try { const r = await fetch(e.data, { method: 'POST' }); postMessage('status ' + r.status); } catch (err) { postMessage('error ' + err.name); } };", {
        headers: { 'content-type': 'text/javascript' },
      });
    return new Response(`answer for ${path}`, { status: 200 });
  },
});
const ORIGIN = `http://127.0.0.1:${server.port}`;

const profile = mkdtempSync(join(tmpdir(), 'fault-live-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', `${ORIGIN}/`], { stdio: 'ignore' });

const quiet = () => {};
let cx = null;
try {
  // Ends on a fact: the page target exists and is on our origin.
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    target = (await listTargets(PORT).catch(() => [])).find((t) => t.url.startsWith(ORIGIN));
    if (!target) await new Promise((r) => setTimeout(r, 100));
  }
  if (!target) throw new Error(`headless Chrome never showed ${ORIGIN}/ on port ${PORT}`);
  cx = connect(target.webSocketDebuggerUrl);
  await cx.ready;
  await cx.send('Runtime.enable');
  // THE TARGET IS LISTED UNDER ITS URL BEFORE ITS DOCUMENT IS: the first evaluate can still meet
  // `about:blank`, where a relative fetch is an invalid URL and fails as a TypeError - which reads
  // exactly like the `lose-answer` this file asserts. So wait for the document, a fact.
  await until(cx, `location.origin === '${ORIGIN}' && document.readyState === 'complete'`, 10000);

  const post = (path) =>
    evaluate(cx, `fetch('${path}', { method: 'POST', cache: 'no-store' }).then((r) => 'status ' + r.status, (e) => 'error ' + e.name)`);
  const startPost = (key, path) =>
    evaluate(cx, `(window['${key}'] = null, fetch('${path}', { method: 'POST' }).then((r) => (window['${key}'] = 'status ' + r.status), (e) => (window['${key}'] = 'error ' + e.name)), true)`);
  const outcome = (key) => evaluate(cx, `window['${key}']`);
  const untilOutcome = async (key) => {
    for (let i = 0; i < 100; i++) {
      const v = await outcome(key);
      if (v !== null) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  };

  // lose-answer once
  {
    const f = await armFault(cx, [{ match: '/commit', method: 'POST', fault: 'lose-answer once' }], { log: quiet });
    const page = await post('/commit');
    ok('lose-answer: the SERVER received the request', count('/commit') === 1, `server count ${count('/commit')}`);
    ok('lose-answer: the PAGE saw a transport failure', page === 'error TypeError', page);
    ok('lose-answer: the record carries the real status it discarded', f.records[0]?.realStatus === 200);
    const again = await post('/commit');
    ok('lose-answer once: the resubmission reaches the page untouched', again === 'status 200' && count('/commit') === 2, again);
    await f.disarm();
  }

  // status (response stage) vs status-unsent (request stage)
  {
    const f = await armFault(cx, [{ match: '/ran', fault: 'status 503' }, { match: '/unsent', fault: 'status-unsent 503' }], { log: quiet });
    const ran = await post('/ran');
    const unsent = await post('/unsent');
    ok('status 503: the page sees 503 and the server DID run', ran === 'status 503' && count('/ran') === 1, `${ran}, server ${count('/ran')}`);
    ok('status-unsent 503: the page sees 503 and the server NEVER saw it', unsent === 'status 503' && count('/unsent') === 0, `${unsent}, server ${count('/unsent')}`);
    await f.disarm();
  }

  // status 401 once
  {
    const f = await armFault(cx, [{ match: '/token', fault: 'status 401 once' }], { log: quiet });
    const first = await post('/token');
    const second = await post('/token');
    ok('status 401 once: first 401, second the real 200', first === 'status 401' && second === 'status 200', `${first} then ${second}`);
    await f.disarm();
  }

  // hold (request stage): neither the server nor the page moves until release
  {
    const f = await armFault(cx, [{ match: '/held', fault: 'hold' }], { log: quiet });
    await startPost('h1', '/held');
    await f.awaitHeld(1, 5000);
    ok('hold: the server has NOT seen it while held', count('/held') === 0);
    ok('hold: the page is still waiting', (await outcome('h1')) === null);
    await f.release();
    const v = await untilOutcome('h1');
    ok('hold: after release, the server answers and the page sees it', v === 'status 200' && count('/held') === 1, `${v}, server ${count('/held')}`);
    await f.disarm();
  }

  // hold-answer (response stage): the server ran, the page waits
  {
    const f = await armFault(cx, [{ match: '/answered', fault: 'hold-answer' }], { log: quiet });
    await startPost('h2', '/answered');
    await f.awaitHeld(1, 5000);
    ok('hold-answer: the server HAS run it while the page waits', count('/answered') === 1 && (await outcome('h2')) === null);
    await f.fail();
    const v = await untilOutcome('h2');
    ok('hold-answer + fail(): the page sees a transport failure', v === 'error TypeError', v);
    await f.disarm();
  }

  // delay
  {
    const f = await armFault(cx, [{ match: '/slow', fault: 'delay 800 once' }], { log: quiet });
    const t0 = Date.now();
    const v = await post('/slow');
    const ms = Date.now() - t0;
    ok('delay 800: the real answer, at least 800 ms later', v === 'status 200' && ms >= 800, `${v} after ${ms} ms`);
    await f.disarm();
  }

  // a fault that never fired is reported
  {
    const f = await armFault(cx, [{ match: '/nobody-calls-this', fault: 'lose-answer' }], { log: quiet });
    await post('/something-else');
    const rep = await f.disarm();
    ok('a rule that never fired is reported vacuous', rep.vacuous.join() === '0');
  }

  // MEASUREMENT: does Fetch on the page session reach a dedicated Worker's request?
  {
    const f = await armFault(cx, [{ match: '/from-worker', fault: 'status-unsent 418' }], { log: quiet });
    const v = await evaluate(
      cx,
      `new Promise((res) => { const w = new Worker('/worker.js'); w.onmessage = (e) => res(e.data); w.postMessage('/from-worker'); setTimeout(() => res('no answer'), 5000); })`,
    );
    console.log(`  note   a dedicated Worker's fetch under 'status-unsent 418': worker saw '${v}', rule fired ${f.fired(0)}x, server saw ${count('/from-worker')}`);
    await f.disarm();
  }
} catch (e) {
  ok(`the live run completed (${e instanceof Error ? e.message : String(e)})`, false);
} finally {
  cx?.close();
  // CLOSED THROUGH THE BROWSER, AND WAITED FOR: `chrome.kill()` ends the launcher alone on Windows,
  // and its children kept the profile open, so the temporary directory could not be removed (EBUSY,
  // one run in eight). `Browser.close` ends the whole browser; the process exit is the fact.
  const exited = new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once('exit', r)));
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const browser = connect(webSocketDebuggerUrl);
    await browser.ready;
    // The socket dies with the browser, so an error here is expected and only noted.
    await browser.send('Browser.close').catch((e) => console.log(`  note   Browser.close: ${e.message}`));
  } catch (e) {
    console.log(`  note   Browser.close could not be sent (${e instanceof Error ? e.message : String(e)}), killing`);
    chrome.kill();
  }
  await exited;
  server.stop(true);
  rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

console.log(
  failures
    ? `[fault-live] ${failures} FAILURE(S) - Chrome does not do with a fault what the rows rely on`
    : '[fault-live] clean - each mode measured from the server and the page, no estate touched',
);
process.exit(failures ? 1 : 0);
