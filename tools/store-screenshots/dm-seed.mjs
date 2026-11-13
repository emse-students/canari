#!/usr/bin/env bun
/**
 * The direct conversations of the demo on DEV (scenario.json `dms`), created and spoken in by live
 * clients so the conversation list of a shot shows a real week and not one lonely group.
 *
 *   bun dm-seed.mjs --lang fr|en --ports third=9231,owner=9232,peer=9233,fourth=9234
 *
 * Same seats and same door as chat-seed.mjs (the rig's dev-only site check). The creator of a pair
 * opens the DM with the rig's `createDM`; each message is sent by the seat the scenario names, and
 * the next one waits until the sender's pane shows the previous one.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_TAB, awaitMessage, clickAtPoint, client, evaluate, send } from '../cross-client-harness/chat.mjs';
import { createDM } from '../cross-client-harness/groupnav.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(readFileSync(join(HERE, 'scenario.json'), 'utf8'));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const lang = opt('lang', 'fr');
const ports = Object.fromEntries(opt('ports', '').split(',').filter(Boolean).map((p) => p.split('=')));
const NAMES = { third: 'Lina', owner: 'Mathis', peer: 'Sana', fourth: 'Tom' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Opens the DM tile naming `contact` (a DM tile starts with the contact's name). */
async function openDm(cx, contact) {
  await evaluate(cx, "location.assign('/chat')");
  await sleep(12000);
  const spot = JSON.parse(await evaluate(cx, `JSON.stringify((function () { var t = [].slice.call(document.querySelectorAll('[data-conversation-tile]')).filter(function (e) { var x = (e.innerText || '').replace(/\\s+/g, ' '); return e.getBoundingClientRect().width > 0 && x.indexOf(${JSON.stringify(contact)}) !== -1; }); if (t.length !== 1) return { n: t.length }; t[0].scrollIntoView({ block: 'center' }); var r = t[0].getBoundingClientRect(); return { n: 1, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })())`));
  if (spot.n !== 1) throw new Error(`${spot.n} tiles name ${contact}`);
  await cx.send('Page.bringToFront');
  await clickAtPoint(cx, spot.x, spot.y);
  await sleep(4000);
}

const skip = Number(opt('skip', 0));
for (const [i, dm] of scenario.dms.entries()) {
  if (i < skip) continue;
  const [[firstKey, firstText], ...rest] = dm.messages[lang];
  if (firstKey !== dm.a) throw new Error('a pair opens with its creator speaking (the DM has no tile before its first message)');
  const creator = await client(Number(ports[dm.a]), APP_TAB, { focus: false });
  console.log(`[dm-seed] ${NAMES[dm.a]} opens a DM with ${NAMES[dm.b]}`);
  // The list view, not an open conversation: on a narrow window the "new discussion" control is hidden behind a pane.
  await evaluate(creator, "location.assign('/chat')");
  await sleep(12000);
  await createDM(creator, NAMES[dm.b]);
  await send(creator, firstText);
  await awaitMessage(creator, firstText, 30_000);
  console.log(`[dm-seed] ${NAMES[dm.a]}: ${firstText}`);
  creator.close();
  await sleep(6000);
  for (const [key, text] of rest) {
    const cx = await client(Number(ports[key]), APP_TAB, { focus: false });
    await openDm(cx, NAMES[key === dm.a ? dm.b : dm.a]);
    await send(cx, text);
    await awaitMessage(cx, text, 30_000);
    console.log(`[dm-seed] ${NAMES[key]}: ${text}`);
    cx.close();
    await sleep(2500);
  }
}
console.log('[dm-seed] done');
process.exit(0);
