/**
 * THE BIG-ACCOUNT BENCH FOR `community-open.mjs`: TEN COMMUNITIES, ONE OF THEM WIDE AND LONG.
 *
 *   ANDROID_SERIAL=<serial> bun tools/cold-start/community-bench-seed.mjs [--communities 8] [--salons 8] [--messages 200]
 *
 * Creates, THROUGH THE APP ON THE PHONE (the dialogs and the composer a member uses - a salon message
 * is end-to-end encrypted by the client, so the composer is the only way to write one):
 *   - `--communities` communities named `BancOuverture-<n>` (with the account's existing ones, the
 *     "ten-community bench" the queue names);
 *   - in `BancOuverture-1`, `--salons` more public salons `salon-<n>`;
 *   - in `BancOuverture-1`'s first salon, `--messages` short texts, so a salon open decodes and draws
 *     the server's whole 200-row page.
 *
 * IDEMPOTENT BY NAME: a community or salon already listed is not created again, and the message count
 * is topped up from what the salon already shows. DEV ESTATE AND BENCH ACCOUNTS ONLY - it refuses to
 * run unless the page's API origin is `dev.canari-emse.fr`.
 */
import { activate, connect, evaluate, listTargets, realClick, until } from '../cross-client-harness/cdp.mjs';
import { adb, deviceSerial, pidOf, waitMs } from './device.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const COMMUNITIES = opt('communities', 8);
const SALONS = opt('salons', 8);
const MESSAGES = opt('messages', 200);
const PORT = 9334;

const serial = await deviceSerial();
const pid = await pidOf(serial);
if (!pid) throw new Error('start the app first: the seed drives a signed-in session');
await adb(serial, ['forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
const page = (await listTargets(PORT)).find((t) => t.url.startsWith('http://tauri.localhost'));
const cx = connect(page.webSocketDebuggerUrl);
await cx.ready;
await cx.send('Runtime.enable');

const apiOrigin = await evaluate(cx, `(performance.getEntriesByType('resource').map(function (e) { return e.name; }).find(function (u) { return /^https:[/][/][^/]*canari[^/]*[/]api[/]/.test(u); }) || '')`);
if (!apiOrigin.startsWith('https://dev.canari-emse.fr/')) throw new Error(`refusing: this app talks to ${apiOrigin || 'nothing yet'}, not the dev estate`);

const visible = (sel) => `[].find.call(document.querySelectorAll(${JSON.stringify(sel)}), function (e) { return e.getBoundingClientRect().width > 0; })`;
const buttonWithText = (text) => `[].find.call(document.querySelectorAll('button'), function (b) { return ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).indexOf(${JSON.stringify(text)}) >= 0 && b.getBoundingClientRect().width > 0; })`;
const railNames = async () =>
  JSON.parse(await evaluate(cx, `(function () { var add = ${visible('button[aria-label="Ajouter une communauté"]')}; return JSON.stringify(add ? [].filter.call(add.parentElement.querySelectorAll('button[title]'), function (b) { return b !== add; }).map(function (b) { return b.title; }) : []); })()`));

/** Clicks the element a page expression resolves to (the selectors here need visibility filters). */
async function press(expr) {
  const hit = await evaluate(cx, `(function () { var e = ${expr}; if (!e) return false; e.click(); return true; })()`);
  if (!hit) throw new Error(`nothing to press: ${expr.slice(0, 120)}`);
}

async function toHub() {
  // A creation opens the new community's salon, which hides the bottom nav on a phone: back first.
  if (await evaluate(cx, `!!${visible('button[aria-label="Retour au menu"]')}`)) {
    await press(visible('button[aria-label="Retour au menu"]'));
    await waitMs(600);
  }
  if (await evaluate(cx, `!!${visible('a[href="/communities"]')}`)) await press(visible('a[href="/communities"]'));
  await until(cx, `!!${visible('button[aria-label="Ajouter une communauté"]')}`, 20000);
}

async function submitDialog(inputId, name, buttonText) {
  await until(cx, `!!document.querySelector('#${inputId}')`, 10000);
  await realClick(cx, `#${inputId}`);
  await cx.send('Input.insertText', { text: name });
  await until(cx, `(function () { var b = ${buttonWithText(buttonText)}; return !!b && !b.disabled; })()`, 8000);
  await press(buttonWithText(buttonText));
}

await toHub();
for (let n = 1; n <= COMMUNITIES; n++) {
  const name = `BancOuverture-${n}`;
  if ((await railNames()).includes(name)) continue;
  await press(visible('button[aria-label="Ajouter une communauté"]'));
  await submitDialog('new-community-name', name, 'Créer la communauté');
  await waitMs(4000);
  await toHub();
  await until(cx, `!!${visible(`button[title=${JSON.stringify(name)}]`)}`, 30000);
  console.log(`community ${name} created`);
}

await press(visible('button[title="BancOuverture-1"]'));
await waitMs(800);
for (let n = 1; n <= SALONS; n++) {
  const name = `salon-${n}`;
  if (await evaluate(cx, `!!${visible(`[data-channel-row=${JSON.stringify(name)}]`)}`)) continue;
  await press(buttonWithText('Ajouter un canal'));
  await submitDialog('new-channel-name', name, 'Créer le canal');
  await waitMs(2500);
  console.log(`salon ${name} created`);
  await toHub();
  await press(visible('button[title="BancOuverture-1"]'));
  await waitMs(800);
}

// The FIRST salon of the community, the one `community-open.mjs` opens.
await press(visible('[data-channel-row]'));
await until(cx, `!!document.querySelector('.chat-composer-footer .chat-composer-editor')`, 20000);
await waitMs(3000);
const already = Number(await evaluate(cx, `document.querySelectorAll('[id^="msg-"]').length`));
console.log(`first salon shows ${already} message(s); sending ${Math.max(0, MESSAGES - already)}`);
for (let i = already + 1; i <= MESSAGES; i++) {
  await realClick(cx, '.chat-composer-footer .chat-composer-editor');
  await cx.send('Input.insertText', { text: `banc ouverture ${i}` });
  await activate(cx, 'text=Envoyer le message');
  await until(cx, `!document.querySelector('.chat-composer-footer .chat-composer-editor').innerText.trim()`, 10000);
  if (i % 25 === 0) console.log(`  ${i} sent`);
  await waitMs(150);
}
cx.close();
process.exit(0);
