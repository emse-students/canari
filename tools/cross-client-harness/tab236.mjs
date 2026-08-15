/**
 * TAB-2, TAB-3 and TAB-6 - the three ways a client goes away and comes back.
 *
 *   TAB-2  the TAB is closed while a message arrives, then reopened
 *   TAB-3  the whole BROWSER is killed while messages arrive, then relaunched
 *   TAB-6  the refresh cookie is deleted, then the app is made to act
 *
 * Each is run on its own (`node tab236.mjs 2`), because they are destructive in increasing order
 * and TAB-6 ends with W1 logged out - it re-logs in at the end, but a failure there leaves it on
 * the login screen and everything after would fail for that reason instead of its own.
 *
 * TAB-6 is the one worth stating: the failure it looks for is NOT an error. It is the app deciding
 * that a session it cannot refresh is a session with nothing in it - a silent empty list, which
 * looks to a user exactly like every conversation having been deleted.
 */
import { execFileSync } from 'node:child_process';
import { client, ensureChat, openConversation, countMessage, awaitMessage, send, evaluate } from './chat.mjs';
import { listTargets, connect, until } from './cdp.mjs';
import { watch, report } from './watch.mjs';
import { mark } from './results.mjs';
import { killBrowser, startBrowser, BROWSERS } from './launch.mjs';
import { ACCOUNT_OF, PORTS, peerNameFor } from './names.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const which = String(process.argv[2] || '2');
const rows = [];

/** Enters the PIN through the CLI, which reads it from test-accounts.json - never from argv. */
function unlock(port, account) {
  try {
    const out = execFileSync(
      process.execPath,
      ['pin.mjs', '--port', String(port), '--account', account, '--match', 'canari-emse.fr'],
      { cwd: new URL('.', import.meta.url).pathname.replace(/^\//, ''), encoding: 'utf8' }
    );
    return out.trim().split('\n').pop();
  } catch (e) {
    return `pin.mjs failed: ${String(e.stdout || e.message).slice(0, 200)}`;
  }
}

/**
 * True when the page is showing a LOGIN form - which the PIN unlock modal is not.
 *
 * The distinction is the whole point of TAB-3, and the first version got it backwards: the unlock
 * field is `#encryption-pin`, an `input[type=password]`, so "a password field is on screen" scored
 * the modal as a re-login and failed a check that had actually passed.
 */
const LOGIN_SHOWING = `(function () {
  if (document.querySelector('#encryption-pin')) return false;
  if (document.querySelector('input[type=email], input[name=email], input[autocomplete=username]')) return true;
  if (/^\\/(auth|login)/.test(location.pathname)) return true;
  var t = document.body ? document.body.innerText : '';
  return /se connecter|connexion avec|identifiant/i.test(t) && !document.querySelector('.chat-composer-editor');
})()`;

// ── TAB-2: the tab is closed, a message arrives, the tab is reopened ──────────
if (which === '2') {
  const w1 = await client(9224, 'canari-emse.fr');
  const w2 = await client(9223, 'canari-emse.fr');
  await ensureChat(w2);
  await openConversation(w2, peerNameFor('W2'));

  // A blank sibling keeps the browser alive once the app tab goes; closing the last tab would
  // exit Chrome and turn this into TAB-3.
  await evaluate(w1, `(function () { window.__keep = window.open('about:blank', '_blank'); return !!window.__keep; })()`);
  await sleep(500);
  const appTarget = (await listTargets(9224)).find((t) => t.url.includes('canari-emse.fr'));
  await fetch(`http://127.0.0.1:9224/json/close/${appTarget.id}`);
  await sleep(1500);
  const stillThere = (await listTargets(9224)).some((t) => t.url.includes('canari-emse.fr'));

  const o2 = await watch(w2, 'tab2-w2');
  const m = mark('TAB2');
  await send(w2, `${m} sent while the tab was closed`);
  await sleep(12_000);

  // Reopen by navigating a blank tab, NOT with `PUT /json/new?url=`: this Chrome ignores the url
  // parameter and opens `about:blank`, so the reopened tab was never the app and every later step
  // failed looking for a target that did not exist.
  const blanks = (await listTargets(9224)).filter((t) => t.url.startsWith('about:blank'));
  for (const extra of blanks.slice(1)) await fetch(`http://127.0.0.1:9224/json/close/${extra.id}`);
  const reopened = connect(blanks[0].webSocketDebuggerUrl);
  await reopened.ready;
  await reopened.send('Page.enable');
  await reopened.send('Page.navigate', { url: 'https://canari-emse.fr/chat' });
  await sleep(12_000);
  const pinResult = unlock(PORTS.W1, ACCOUNT_OF.W1);
  await sleep(4_000);

  const w1b = await client(9224, 'canari-emse.fr');
  const o1 = await watch(w1b, 'tab2-w1');
  await openConversation(w1b, peerNameFor('W1'));
  const arrived = await awaitMessage(w1b, m, 30_000).then(() => true, () => false);
  await sleep(2_000);
  const count = await countMessage(w1b, m);

  rows.push({
    check: 'TAB-2 tab closed -> message -> reopened',
    marker: m,
    tabReallyClosed: !stillThere,
    pin: pinResult,
    arrived,
    count,
    verdict: !stillThere && count === 1 ? 'PASS' : 'FAIL',
    w1Notable: (await report(o1)).notable,
    w2Notable: (await report(o2)).notable,
  });
}

// ── TAB-3: the whole browser is killed, messages arrive, it is relaunched ─────
if (which === '3') {
  const w2 = await client(9223, 'canari-emse.fr');
  await ensureChat(w2);
  await openConversation(w2, peerNameFor('W2'));

  // killBrowser throws unless the port really stops answering, so `down` is proven, not assumed.
  const downInMs = await killBrowser('w1');
  const down = true;

  const o2 = await watch(w2, 'tab3-w2');
  const m1 = mark('TAB3A');
  const m2 = mark('TAB3B');
  await send(w2, `${m1} first while the browser was down`);
  await sleep(1_500);
  await send(w2, `${m2} second while the browser was down`);
  await sleep(10_000);

  const upIn = await startBrowser('w1');
  await sleep(12_000);

  // Assert the profile carried the login BEFORE unlocking: the PIN modal is not a login form, and
  // the distinction is the whole point of this check.
  const w1 = await client(9224, 'canari-emse.fr');
  const loginShowing = await evaluate(w1, LOGIN_SHOWING);
  const pinResult = unlock(PORTS.W1, ACCOUNT_OF.W1);
  await sleep(4_000);

  const w1b = await client(9224, 'canari-emse.fr');
  const o1 = await watch(w1b, 'tab3-w1');
  await ensureChat(w1b);
  await openConversation(w1b, peerNameFor('W1'));
  // A cold start has to unlock, reconnect and fetch the queue before anything can decrypt, so the
  // window here is generous AND the elapsed time is reported: how long a relaunched browser takes
  // to catch up is the interesting number, and a 30 s window turned a pass into a false failure.
  const t0 = Date.now();
  const got1 = await awaitMessage(w1b, m1, 120_000).then(() => Date.now() - t0, () => null);
  const got2 = await awaitMessage(w1b, m2, 60_000).then(() => Date.now() - t0, () => null);
  await sleep(2_000);
  const c1 = await countMessage(w1b, m1);
  const c2 = await countMessage(w1b, m2);

  rows.push({
    check: 'TAB-3 browser killed -> 2 messages -> relaunched',
    browserWasDown: down,
    downInMs,
    upInMs: upIn,
    appTabsOnRelaunch: (await listTargets(9224)).filter((t) => t.url.includes('canari-emse.fr')).length,
    reLoginRequired: loginShowing,
    pin: pinResult,
    first: { afterMs: got1, count: c1 },
    second: { afterMs: got2, count: c2 },
    verdict: down && !loginShowing && c1 === 1 && c2 === 1 ? 'PASS' : 'FAIL',
    w1Notable: (await report(o1)).notable,
    w2Notable: (await report(o2)).notable,
  });
}

// ── TAB-6: the refresh cookie is deleted, then the app is made to act ─────────
if (which === '6') {
  const w1 = await client(9224, 'canari-emse.fr');
  const o1 = await watch(w1, 'tab6-w1');
  await w1.send('Network.enable');

  // `Network.getCookies { urls: ['https://canari-emse.fr'] }` does NOT return it: the refresh
  // cookie is scoped to `/api/auth`, so a request for the site root never sees it. The first
  // version of this check therefore deleted Cloudflare's `cf_clearance` - the only httpOnly cookie
  // it could see - and concluded the app tolerated losing its session. `Storage.getCookies` returns
  // the whole jar, and the cookie is matched BY NAME.
  const { cookies } = await w1.send('Storage.getCookies', {});
  const names = cookies
    .filter((c) => c.domain.includes('canari-emse.fr'))
    .map((c) => `${c.name}@${c.domain}${c.path}${c.httpOnly ? ' httpOnly' : ''}`);
  const refresh = cookies.filter((c) => c.name === 'canari_refresh');
  if (refresh.length === 0) throw new Error(`no canari_refresh cookie to delete; jar: ${names.join(' | ')}`);
  for (const c of refresh) {
    await w1.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });
  }
  const after = (await w1.send('Storage.getCookies', {})).cookies
    .filter((c) => c.domain.includes('canari-emse.fr'))
    .map((c) => c.name);
  if (after.includes('canari_refresh')) throw new Error('canari_refresh survived the delete');

  // The access token lives in memory only, so it survives the cookie deletion. A reload is what
  // forces the app to go and get a new one - and to decide what to do when it cannot.
  await w1.send('Page.reload');
  await sleep(15_000);

  const w1b = await client(9224, 'canari-emse.fr');
  const loginShowing = await evaluate(w1b, LOGIN_SHOWING);
  const path = await evaluate(w1b, 'location.pathname');
  const bodyText = String(await evaluate(w1b, 'document.body ? document.body.innerText.slice(0, 400) : ""'));
  // The failure this looks for: the app decides an unrefreshable session simply has no data, and
  // shows an empty, logged-in-looking list.
  const emptyListInstead = !loginShowing && /discussion/i.test(bodyText) && !/connexion|se connecter/i.test(bodyText);

  rows.push({
    check: 'TAB-6 refresh cookie deleted -> reload',
    cookiesBefore: names,
    deleted: refresh.map((c) => c.name),
    cookiesAfter: after,
    path,
    loginShowing,
    emptyListInstead,
    verdict: loginShowing && !emptyListInstead ? 'PASS' : 'FAIL',
    excerpt: bodyText.replace(/\s+/g, ' ').slice(0, 200),
    w1Notable: (await report(o1)).notable,
  });
}

for (const r of rows) console.log(JSON.stringify(r));
console.log(`\n${rows.filter((r) => r.verdict === 'PASS').length}/${rows.length} pass`);
process.exit(rows.some((r) => r.verdict !== 'PASS') ? 1 : 0);
