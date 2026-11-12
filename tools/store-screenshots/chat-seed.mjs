#!/usr/bin/env bun
/**
 * The MLS half of the demo content on DEV: the group conversation of scenario.json, created and
 * spoken in by live clients (a conversation is encrypted state, so no row can stand in for it).
 *
 *   bun chat-seed.mjs --lang fr|en --ports third=9231,owner=9232,peer=9233,fourth=9234
 *
 * One Chrome per bench account, each signed in and unlocked on dev (README step 1). The creator
 * (the account keyed `third`) creates the group and invites the other three with the rig's own
 * `newgroup.mjs` and `invite.mjs`; the messages are then sent in the scenario's order, each by the
 * member the scenario names, with the rig's `send` (no marker suffix, unlike its CLI) and the next
 * one waits until the sender's pane shows the previous one. Run from this directory: it imports the
 * cross-client rig and refuses anything but the dev estate through the rig's own door (`site.mjs`).
 */
import { spawnSync } from 'node:child_process';
import { APP_TAB, awaitMessage, clickAtPoint, client, evaluate, send } from '../cross-client-harness/chat.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RIG = join(HERE, '..', 'cross-client-harness');
const scenario = JSON.parse(readFileSync(join(HERE, 'scenario.json'), 'utf8'));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const lang = opt('lang', 'fr');
const ports = Object.fromEntries(opt('ports', '').split(',').filter(Boolean).map((p) => p.split('=')));
const title = scenario.conversation.title[lang];
const lines = scenario.conversation.messages[lang];
const NAMES = { third: 'Lina', owner: 'Mathis', peer: 'Sana', fourth: 'Tom' };

/** Opens the LIVE group tile: a deleted earlier attempt leaves a tombstone tile of the same title on every member, which the rig's own opener rightly calls ambiguous. */
async function openLiveGroup(cx, name) {
  await evaluate(cx, "location.assign('/chat')");
  await sleep(6000);
  await evaluate(cx, "(()=>{const el=[...document.querySelectorAll('div,section,aside')].find(d=>d.children.length<=3&&/^Environnement de test/.test(d.textContent.trim())&&d.querySelector('button'));el?.querySelector('button')?.click()})()");
  await sleep(800);
  const spot = JSON.parse(await evaluate(cx, `JSON.stringify((function () { var t = [].slice.call(document.querySelectorAll('[data-conversation-tile]')).filter(function (e) { var x = e.innerText || ''; return e.getBoundingClientRect().width > 0 && x.indexOf(${JSON.stringify(name)}) !== -1 && x.indexOf('supprim') === -1; }); if (t.length !== 1) return { n: t.length }; var r = t[0].getBoundingClientRect(); return { n: 1, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })())`));
  if (spot.n !== 1) throw new Error(`${spot.n} live tiles named ${name}`);
  await cx.send('Page.bringToFront');
  await clickAtPoint(cx, spot.x, spot.y);
  await sleep(5000);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rig = (script, args) => {
  const r = spawnSync(process.execPath, [join(RIG, script), ...args], { encoding: 'utf8', timeout: 240_000 });
  if (r.status !== 0) throw new Error(`${script} failed: ${(r.stderr || r.stdout).slice(-400)}`);
  return r.stdout;
};

/** The first-run modals (birthday offer...) sit over the chat of a fresh seat: dismissed by their own Passer button. */
async function dismissOffers(port) {
  const cx = await client(Number(port), APP_TAB, { focus: false });
  await evaluate(cx, `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Passer')?.click()`);
  cx.close();
}

for (const key of Object.keys(NAMES)) if (!ports[key]) throw new Error(`--ports must name ${key}=<port>`);

for (const p of Object.values(ports)) await dismissOffers(p);
if (!argv.includes('--skip-create')) {
console.log(`[chat-seed] creating "${title}" as ${NAMES.third}`);
rig('newgroup.mjs', ['--port', ports.third, '--name', title]);
for (const key of ['owner', 'peer', 'fourth']) {
  rig('invite.mjs', ['--port', ports.third, '--who', NAMES[key]]);
  console.log(`[chat-seed] invited ${NAMES[key]}`);
}
await sleep(8000);
}

const from = Number(opt('from', 0));
for (const [i, text] of lines.entries()) {
  if (i < from) continue;
  const key = scenario.conversation.speakers[lang][i];
  const cx = await client(Number(ports[key]), APP_TAB, { focus: false });
  await openLiveGroup(cx, title);
  await send(cx, text);
  await awaitMessage(cx, text, 30_000);
  console.log(`[chat-seed] ${NAMES[key]}: ${text}`);
  cx.close();
  await sleep(2500);
}
console.log('[chat-seed] done');
process.exit(0);
