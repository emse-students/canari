/**
 * THE TEN-COMMUNITY UNREAD SCENARIO - what a reader's badges, read marks and receipts do while the
 * reader walks through a lot of communities WITHOUT opening their salons.
 *
 * WHY IT EXISTS (user, 2026-10-08): "messages are marked read though I never opened the community's
 * salon". Nothing in the single-community rows could answer it - the question only exists with
 * several communities, several salons each, and a reader who moves between them. Every step records
 * THREE facts, never only the screen:
 *
 *   ui     what the reader's sidebar draws: the rail dot per community, the badge per salon;
 *   db     the server's read mark of the reader per salon, against the newest message in it
 *          (`channel_members."readMarks"`, `channel_messages`) - the durable state;
 *   wire   which read endpoints the reader's client POSTed (the nginx access log: the OTHER end).
 *
 * A result without the server's side is not believed (testing-methodology). `db` unchanged and
 * `wire` empty means nothing was marked read, whatever the screen says.
 *
 *   bun unread-communities.mjs setup [--n 10]   create the communities, invite the reader, post
 *   bun unread-communities.mjs run <scenario>   one of: arrive, walk, gatewaydown, open [--community X --salon Y --then-reload], mobile
 *   bun unread-communities.mjs snapshot [--sweep]  one reading, nothing moved
 *   bun unread-communities.mjs post --label L    the owner posts 2 messages into every salon
 *
 * ACTORS. W1 is the owner and the POSTER; W2 is the peer and the READER. Both are the campaign's own
 * dedicated accounts on the LOCAL estate - never the user's account and never production.
 * Idempotent: a community that exists is read, not created.
 */
import { execFileSync } from 'node:child_process';
import { requireScript } from './scriptpath.mjs';
import { subjectFor } from './accounts.mjs';
import { awaitAppSettled, clearOverlays, client, ensureChat, evaluate, openChannel, reachCommunities, send, until } from './chat.mjs';
import { acceptInviteLink, createChannel, createCommunity, enterCommunities, inviteLink, listCommunities, openCommunity } from './comm.mjs';
import { PORTS } from './names.mjs';
import { psql } from './estate.mjs';
import { realClick, reloadAndWait } from './cdp.mjs';

const TAG = 'UNR';
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const N = Number(flag('n', 10));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `UNR-01` ... - a two-digit index so a name sorts the way it was made. */
const communityName = (i) => `${TAG}-${String(i).padStart(2, '0')}`;

/**
 * The salons of community `i`. `général` is made by the app (its name is French). Every community has
 * two public salons beyond it; every second a third; every third a private one and every fifth
 * another, both owner-only: the reader is in neither, and must never be counted for them (the table
 * shows `?` for a salon the reader's sidebar does not list, and the server must never count it).
 */
export function salonsOf(i) {
  const s = [
    { name: 'général', isPrivate: false },
    { name: 'salon-a', isPrivate: false },
    { name: 'salon-b', isPrivate: false },
  ];
  if (i % 2 === 0) s.push({ name: 'salon-c', isPrivate: false });
  if (i % 3 === 0) s.push({ name: 'prive-owner', isPrivate: true });
  if (i % 5 === 0) s.push({ name: 'prive-bis', isPrivate: true });
  return s;
}

/** Reaches an in-app route by clicking an injected anchor: the router handles it, nothing reloads. */
async function spaNavigate(cx, route) {
  await evaluate(
    cx,
    `(function () {
      var a = document.getElementById('__unr_link');
      if (!a) {
        a = document.createElement('a');
        a.id = '__unr_link';
        a.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(a);
      }
      a.href = ${JSON.stringify(route)};
      setTimeout(function () { a.click(); }, 0);
      return true;
    })()`
  );
  await sleep(1200);
}

// ---------------------------------------------------------------------------------------------
// The three observers.
// ---------------------------------------------------------------------------------------------

/** What the reader's sidebar draws right now, structurally (no wording). */
async function readUi(cx) {
  return JSON.parse(
    await evaluate(
      cx,
      `(function () {
        var header = document.querySelector('.sidebar-panel h2');
        var dots = [].slice.call(document.querySelectorAll('[data-community-unread-dot]')).map(function (d) {
          var b = d.parentElement && d.parentElement.querySelector('button[title]');
          return b ? b.getAttribute('title') : '?';
        });
        var rows = [].slice.call(document.querySelectorAll('[data-channel-row]')).map(function (b) {
          var badge = b.querySelector('span.rounded-full');
          return {
            name: b.getAttribute('data-channel-row'),
            badge: badge ? (badge.textContent || '').trim() : '',
            current: b.hasAttribute('aria-current')
          };
        });
        return JSON.stringify({
          path: location.pathname,
          title: document.title,
          community: header ? (header.textContent || '').trim() : '',
          dots: dots,
          rows: rows,
          composer: !!document.querySelector('.chat-composer-footer .chat-composer-editor')
        });
      })()`
    )
  );
}

/** The reader's server-side read mark per salon, against the newest message there. */
export function readDb(userSub) {
  const out = psql(
    `select w.name || '/' || c.name, coalesce(cm."readMarks"->>(c.id::text), ''), coalesce((select (extract(epoch from max(m."createdAt"))*1000)::bigint from channel_messages m where m."channelId"=c.id), 0), (select count(*) from channel_messages m where m."channelId"=c.id) from channels c join channel_workspaces w on w.id=c."workspaceId" left join channel_members cm on cm."workspaceId"=w.id and cm."userId"='${userSub}' where w.name like '${TAG}-%' order by 1`
  );
  const marks = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const [key, mark, newest, count] = line.split('|');
    marks.set(key, { mark: mark ? Number(mark) : 0, newest: Number(newest), count: Number(count) });
  }
  return marks;
}

/** The read endpoints the reader's client POSTed since `sinceIso`, from nginx's access log. */
export function readWire(sinceIso) {
  const log = execFileSync('docker', ['logs', '--since', sinceIso, 'canari-local-nginx-1'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const hits = [];
  for (const line of log.split('\n')) {
    const m = line.match(/"POST \/api\/channels\/([0-9a-f-]{36})\/(read-mark|read) HTTP\/1\.\d" (\d+)/);
    if (m) hits.push({ channel: m[1], kind: m[2], status: Number(m[3]) });
  }
  return hits;
}

/** channel id -> `community/salon`, so a wire hit can be named. */
function channelNames() {
  const map = new Map();
  const out = psql(`select c.id, w.name || '/' || c.name from channels c join channel_workspaces w on w.id=c."workspaceId" where w.name like '${TAG}-%'`);
  for (const line of out.split('\n').filter(Boolean)) {
    const [id, name] = line.split('|');
    map.set(id, name);
  }
  return map;
}

/**
 * Clicks every community in the rail ONCE, without opening a salon, and returns each one's rows as
 * the sidebar drew them. This is the measurement AND a gesture under test: switching communities is
 * the thing the user did when the badges "vanished".
 */
async function sweepCommunities(cx) {
  const result = new Map();
  for (const label of await listCommunities(cx)) {
    if (!label.startsWith(TAG)) continue;
    const name = label.replace(/,.*$/, '');
    // The rail label gains a ", unread" suffix while the community has unread salons, so the click
    // addresses the label as drawn and the proof is the panel header, which never carries it.
    await realClick(cx, `[aria-label=${JSON.stringify(label)}]`);
    await until(cx, `((document.querySelector('.sidebar-panel h2') || {}).textContent || '').trim() === ${JSON.stringify(name)}`, 10000).catch(async () => {
      throw new Error(`rail click on ${JSON.stringify(label)} did not open it: ${JSON.stringify(await readUi(cx))}`);
    });
    await awaitAppSettled(cx).catch(() => null);
    result.set(name, await readUi(cx));
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Setup.
// ---------------------------------------------------------------------------------------------

async function setup() {
  const w1 = await client(PORTS.W1);
  const w2 = await client(PORTS.W2);
  await enterCommunities(w1);
  const have1 = new Set((await listCommunities(w1)).map((n) => n.replace(/,.*$/, '')));
  for (let i = 1; i <= N; i++) {
    const name = communityName(i);
    if (!have1.has(name)) {
      console.log(`[setup] creating ${name}`);
      await createCommunity(w1, name);
    } else {
      await openCommunity(w1, name);
    }
    for (const salon of salonsOf(i).slice(1)) {
      const row = await evaluate(w1, `!!document.querySelector('[data-channel-row=${JSON.stringify(salon.name)}]')`);
      if (row === true || row === 'true') continue;
      console.log(`[setup]   ${name}/${salon.name}${salon.isPrivate ? ' (private)' : ''}`);
      await createChannel(w1, salon.name, { visibility: salon.isPrivate ? 'private' : 'public' });
    }
  }
  // Invitations: one link per community, accepted on the reader by an in-app navigation.
  await enterCommunities(w2);
  const have2 = new Set((await listCommunities(w2)).map((n) => n.replace(/,.*$/, '')));
  for (let i = 1; i <= N; i++) {
    const name = communityName(i);
    if (have2.has(name)) continue;
    await openCommunity(w1, name);
    const link = await inviteLink(w1);
    const path = new URL(link).pathname;
    await clearOverlays(w1);
    console.log(`[setup] reader joins ${name}`);
    await spaNavigate(w2, path);
    await until(w2, `document.body.innerText.length > 0`, 10000);
    await acceptInviteLink(w2);
    await enterCommunities(w2);
  }
  console.log('[setup] done');
  w1.close?.();
  w2.close?.();
}

/** Posts `n` messages into every public salon the reader is in, from the owner. */
async function post(label, n = 2, only = null) {
  const w1 = await client(PORTS.W1);
  for (let i = 1; i <= N; i++) {
    const name = communityName(i);
    if (only && !only.includes(i)) continue;
    for (const salon of salonsOf(i)) {
      await openChannel(w1, name, salon.name).catch((e) => {
        throw new Error(`${name}/${salon.name}: ${e.message.slice(0, 200)}`);
      });
      for (let k = 1; k <= n; k++) await send(w1, `${label}-${name}-${salon.name}-${k}`);
    }
  }
  w1.close?.();
}

// ---------------------------------------------------------------------------------------------
// A reading.
// ---------------------------------------------------------------------------------------------

/** One reading of everything, printed as a table of the salons that carry anything at all. */
async function snapshot(label, { cx = null, sinceIso, sweep = false, uiOnly = false } = {}) {
  const reader = cx ?? (await client(PORTS.W2));
  const sub = subjectFor('peer');
  const names = channelNames();
  const ui = sweep ? await sweepCommunities(reader) : new Map([['(current)', await readUi(reader)]]);
  const dbs = readDb(sub);
  const wire = sinceIso ? readWire(sinceIso) : [];
  console.log(`\n=== ${label} ===`);
  const here = await readUi(reader);
  console.log(`page=${here.path} title=${JSON.stringify(here.title)} open=${JSON.stringify(here.community)} rail-dots=${JSON.stringify(here.dots)}`);
  const badges = new Map();
  for (const [, u] of ui) for (const r of u.rows) badges.set(`${u.community}/${r.name}`, r.badge);
  const lines = [];
  for (const [key, d] of dbs) {
    const badge = badges.has(key) ? badges.get(key) || '-' : '?';
    const unreadByMark = d.newest > d.mark ? 'newer-than-mark' : d.count === 0 ? 'empty' : 'mark>=newest';
    lines.push(`${key.padEnd(24)} badge=${String(badge).padEnd(3)} msgs=${String(d.count).padEnd(3)} mark=${d.mark || 0} newest=${d.newest} ${unreadByMark}`);
  }
  if (!uiOnly) console.log(lines.join('\n'));
  const named = wire.map((w) => `${w.kind}:${names.get(w.channel) ?? w.channel.slice(0, 8)}:${w.status}`);
  console.log(`wire: ${named.length ? named.join(' ') : '(no read endpoint POSTed)'}`);
  return { ui, dbs, wire, reader };
}

// ---------------------------------------------------------------------------------------------
// Scenarios. Added as measured.
// ---------------------------------------------------------------------------------------------

const scenarios = {};

/** Reloads the reader past the cache and answers its PIN, as a user's restart does. */
async function restartReader(cx) {
  await reloadAndWait(cx, { ignoreCache: true });
  execFileSync(process.execPath, [requireScript('unlock.mjs'), '--device', 'W2'], { stdio: 'ignore' });
  await sleep(4000);
}

/** The walk and the restart alone, from whatever unread state the reader already holds. */
scenarios.walk = async () => {
  const w2 = await client(PORTS.W2);
  const t1 = new Date().toISOString();
  await reachCommunities(w2);
  await snapshot('W1 reader walked every community, opened no salon', { cx: w2, sinceIso: t1, sweep: true });
  const t2 = new Date().toISOString();
  await restartReader(w2);
  await reachCommunities(w2);
  await snapshot('W2 after a reload of the reader', { cx: w2, sinceIso: t2, sweep: true });
};

/**
 * Messages posted while the reader's socket is DOWN (the gateway is stopped, the owner posts over
 * REST): they reach no salon row on the reader, so the live tally can never count them.
 */
scenarios.gatewaydown = async () => {
  const w2 = await client(PORTS.W2);
  await reachCommunities(w2);
  const t0 = new Date().toISOString();
  await snapshot('G0 before the gateway stops', { cx: w2, sinceIso: t0, sweep: true });
  execFileSync('docker', ['stop', 'canari-local-chat-gateway-1'], { stdio: 'ignore' });
  try {
    await post('G', 1, [1, 2, 3]);
  } finally {
    execFileSync('docker', ['start', 'canari-local-chat-gateway-1'], { stdio: 'ignore' });
  }
  await until(w2, `document.title.indexOf('(') >= 0`, 60000).catch(() => null);
  await sleep(15000); // the reconnect ladder and the refetch: read as a fact below, not waited for blind
  const t1 = new Date().toISOString();
  await snapshot('G1 three communities received a message while the socket was down', { cx: w2, sinceIso: t1, sweep: true });
};

/** Opens ONE salon of ONE community, walks away and back: only that salon may be marked read. */
scenarios.open = async () => {
  const w2 = await client(PORTS.W2);
  await reachCommunities(w2);
  const t0 = new Date().toISOString();
  await snapshot('O0 before opening anything', { cx: w2, sinceIso: t0, sweep: true });
  const t1 = new Date().toISOString();
  await realClick(w2, `[aria-label^=${JSON.stringify(flag('community', 'UNR-05'))}]`);
  await realClick(w2, `[data-channel-row=${JSON.stringify(flag('salon', 'salon-a'))}]`);
  await until(w2, `!!document.querySelector('.chat-composer-footer .chat-composer-editor')`, 15000);
  await sleep(4000); // the 2 s receipt debounce plus the round trip: a fact the server then states
  await snapshot(`O1 ${flag('community', 'UNR-05')}/${flag('salon', 'salon-a')} opened`, { cx: w2, sinceIso: t1, sweep: false });
  const t2 = new Date().toISOString();
  await snapshot('O2 every community walked again after one salon was read', { cx: w2, sinceIso: t2, sweep: true });
  if (args.includes('--then-reload')) {
    const t3 = new Date().toISOString();
    await restartReader(w2);
    await reachCommunities(w2);
    await snapshot('O3 after a reload: the salon that was read must stay read, the others stay unread', { cx: w2, sinceIso: t3, sweep: true });
  }
};

/** The same walk on a phone-sized layout, with Back, where a selection can outlive its screen. */
scenarios.mobile = async () => {
  const w2 = await client(PORTS.W2);
  await w2.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await w2.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  try {
    await sleep(1500);
    await reachCommunities(w2);
    const t0 = new Date().toISOString();
    await snapshot('M0 phone layout, communities screen', { cx: w2, sinceIso: t0, sweep: true });
    const t1 = new Date().toISOString();
    await realClick(w2, `[aria-label^=${JSON.stringify('UNR-07')}]`);
    await realClick(w2, '[data-channel-row="salon-b"]');
    await until(w2, `!!document.querySelector('.chat-composer-footer .chat-composer-editor')`, 15000);
    await sleep(4000);
    await snapshot('M1 UNR-07/salon-b opened on the phone layout', { cx: w2, sinceIso: t1 });
    const t2 = new Date().toISOString();
    await evaluate(w2, `history.back(), true`);
    await sleep(1500);
    await snapshot('M2 after Back (selection must be gone, nothing else read)', { cx: w2, sinceIso: t2, sweep: true });
  } finally {
    await w2.send('Emulation.clearDeviceMetricsOverride');
    await w2.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }
};

/** Messages land while the reader is NOT on the communities screen; then it walks, then restarts. */
scenarios.arrive = async () => {
  const w2 = await client(PORTS.W2);
  await ensureChat(w2);
  const t0 = new Date().toISOString();
  await post('A', 2);
  await snapshot('A1 after posts, reader on /chat', { cx: w2, sinceIso: t0 });
  const t1 = new Date().toISOString();
  await reachCommunities(w2);
  await snapshot('A2 reader walked every community, opened no salon', { cx: w2, sinceIso: t1, sweep: true });
  const t2 = new Date().toISOString();
  await restartReader(w2);
  await reachCommunities(w2);
  await snapshot('A3 after a reload of the reader', { cx: w2, sinceIso: t2, sweep: true });
};

const [cmd, name] = args;
if (cmd === 'setup') await setup();
else if (cmd === 'post') await post(flag('label', 'p'), Number(flag('k', 2)));
else if (cmd === 'snapshot') await snapshot('snapshot', { sinceIso: flag('since', new Date(Date.now() - 60_000).toISOString()), sweep: args.includes('--sweep') });
else if (cmd === 'run' && scenarios[name]) await scenarios[name]();
else {
  console.log('usage: setup | post | snapshot [--sweep] | run <scenario>');
  process.exit(2);
}
process.exit(0);

