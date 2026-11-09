#!/usr/bin/env bun
/**
 * The communities of the demo on DEV (scenario.json `communities`), built by live clients with the
 * rig's own gestures: the owner creates the community and its salons and mints the invite LINK; the
 * other seats open the link and join (a link, not a direct invitation, so no "invited you" line
 * lands in anybody's conversation list); each seat then says one line in the first salon it lands in.
 *
 *   bun comm-seed.mjs --lang fr|en --ports third=9231,owner=9232,peer=9233,fourth=9234
 *
 * Same seats and the same dev-only door as chat-seed.mjs. The rig records what it creates in its
 * campaign ledger, so these communities can be removed through `comm.mjs`'s own deleteCommunity.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_TAB, awaitMessage, client, evaluate, send } from '../cross-client-harness/chat.mjs';
import { closeOverlays } from '../cross-client-harness/groupnav.mjs';
import { acceptInviteLink, createChannel, createCommunity, enterCommunities, inviteLink, openCommunity, openInviteLink } from '../cross-client-harness/comm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(readFileSync(join(HERE, 'scenario.json'), 'utf8'));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const lang = opt('lang', 'fr');
const ports = Object.fromEntries(opt('ports', '').split(',').filter(Boolean).map((p) => p.split('=')));
const NAMES = { third: 'Lina', owner: 'Mathis', peer: 'Sana', fourth: 'Tom' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seat = (key) => client(Number(ports[key]), APP_TAB, { focus: false });

for (const [ci, c] of scenario.communities.entries()) {
  if (ci < Number(opt('from', 0))) continue;
  console.log(`[comm-seed] ${NAMES[c.owner]} creates "${c.name}"`);
  const ownerCx = await seat(c.owner);
  await evaluate(ownerCx, "location.assign('/chat')");
  await sleep(12000);
  // A wide window: the salon list is a drawer in the phone-width layout, and the rig's channel gestures need it in place.
  await ownerCx.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  if (argv.includes('--resume')) { await enterCommunities(ownerCx); await openCommunity(ownerCx, c.name); }
  else await createCommunity(ownerCx, c.name);
  for (const ch of c.channels) await createChannel(ownerCx, ch);
  const url = await inviteLink(ownerCx);
  console.log(`[comm-seed] link minted for "${c.name}"`);
  for (const key of Object.keys(NAMES)) {
    if (key === c.owner) continue;
    const text = c.hello[key]?.[lang];
    const cx = await seat(key);
    const r = await openInviteLink(cx, url);
    if (!r.valid) throw new Error(`${NAMES[key]}: the link of "${c.name}" was refused`);
    await acceptInviteLink(cx);
    await sleep(4000);
    if (text) {
      await send(cx, text);
      await awaitMessage(cx, text, 30_000);
    }
    console.log(`[comm-seed] ${NAMES[key]} joined "${c.name}": ${text ?? '(silent)'}`);
    cx.close();
    await sleep(2500);
  }
  const text = c.hello[c.owner]?.[lang];
  if (text) {
    await closeOverlays(ownerCx);
    await send(ownerCx, text);
    await awaitMessage(ownerCx, text, 30_000);
    console.log(`[comm-seed] ${NAMES[c.owner]}: ${text}`);
  }
  await ownerCx.send('Emulation.clearDeviceMetricsOverride');
  ownerCx.close();
}
console.log('[comm-seed] done');
process.exit(0);
