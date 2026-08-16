/**
 * DOES THE REFUSAL FIRE? A guard that has never been seen to trigger is a guard nobody has tested.
 *
 * Makes W2 ambiguous on purpose, asserts `client()` refuses it in BOTH forms (with a URL match and
 * without), then repairs it with the same seam the preflight uses and asserts the refusal stops.
 *
 * Usage: node tabguard-selftest.mjs
 */
import { client } from './chat.mjs';
import { closeExtraAppTabs } from './tabs.mjs';
import { connect } from './cdp.mjs';
import { PORTS, SITE } from './names.mjs';

const port = PORTS.W2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

// A browser with one tab must be accepted, or the rest of this proves nothing.
await client(port, SITE).then(
  (cx) => {
    cx.close();
    check('one tab is accepted', true);
  },
  (e) => check('one tab is accepted', false, e.message)
);

const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const browser = connect(webSocketDebuggerUrl);
await browser.ready;
const { targetId } = await browser.send('Target.createTarget', { url: `${SITE}/chat`, newWindow: false });
await sleep(2500);

const refuses = async (label, args) =>
  client(...args).then(
    (cx) => {
      cx.close();
      return check(label, false, 'it returned a client instead of refusing');
    },
    (e) => check(label, /so no tab can be chosen/.test(e.message), e.message.slice(0, 120))
  );

await refuses('two tabs, with a match, is refused', [port, SITE]);
await refuses('two tabs, without a match, is refused', [port]);

// The deliberate-sibling opt-in must still work, or the TAB phase has no way through.
await client(port, SITE, { allowMany: true }).then(
  (cx) => {
    cx.close();
    check('allowMany still resolves', true);
  },
  (e) => check('allowMany still resolves', false, e.message)
);

const closed = await closeExtraAppTabs(port);
check('the repair closed exactly one tab', closed === 1, `closed ${closed}`);
await sleep(500);
await client(port, SITE).then(
  (cx) => {
    cx.close();
    check('the browser is accepted again after the repair', true);
  },
  (e) => check('the browser is accepted again after the repair', false, e.message)
);

try {
  browser.close();
} catch {
  /* gone */
}
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall assertions held');
process.exitCode = fails.length ? 1 : 0;
