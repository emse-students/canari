/**
 * Tops the LOCAL estate up with what the verification rows need to look at: a feed long enough to
 * scroll, a video post, upcoming agenda events, and a salon of a hundred messages.
 *
 *   bun seed-bench.mjs [--dry] [--only posts,video,events,salon] [--posts N] [--events N] [--messages N]
 *
 * WHY IT EXISTS. A local estate rebuilt from the schema holds one post, no event and a venue of a few
 * dozen messages, so a row about scrolling `/posts`, the feed's video player, the agenda or a long
 * salon had nothing to scroll, play or open - and every session seeded by hand, differently.
 *
 * IDEMPOTENT, BECAUSE EVERY COUNT IS A TARGET. Each part reads the TABLE first and creates only the
 * difference, so a second run is reads alone. Everything it makes carries `[bench-seed]` (posts,
 * events) or lives in containers it owns (the `banc-essai` association, the `banc-defilement` salon),
 * which is what a reader of the estate - or a later sweep - can tell it by.
 *
 * THROUGH THE PRODUCT, NEVER THE DATABASE. Posts, the video's encrypted upload and the events go
 * through the same `/api` routes the app calls, from the client's OWN page with its own refreshed
 * token (the pattern `chat.mjs`'s `apiCall` documents). Salon messages are end-to-end encrypted by
 * the client, so the only way to write one is the composer: they are TYPED and SENT on W1.
 *
 * WHO DOES WHAT. W1 (`owner`) writes the posts and the salon; W2 (`peer`) creates the association and
 * its events, because creating an association and validating an event need a global admin and on the
 * local estate that is the peer account. A missing grant is reported, not worked around.
 *
 * LOCAL ONLY. It refuses to start unless `SITE` is this machine: seeded content on a real estate would
 * be content real members read.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { client, evaluate, openChannel, send } from './chat.mjs';
import { createChannel, enterCommunities, openCommunity } from './comm.mjs';
import { LOCAL, psql } from './estate.mjs';
import { channelIdOf, channelMessageCount, userIdOf, workspaceIdOf } from './grainedb.mjs';
import { OWNER_NAME, PEER_NAME, PORTS, VENUE } from './names.mjs';
import { parseSeedArgs } from './seedargs.mjs';

const MARK = '[bench-seed]';
const ASSOCIATION = { name: "Banc d'essai", slug: 'banc-essai' };
const SALON = 'banc-defilement';
const VIDEO = join(import.meta.dirname, 'fixtures', 'bench-video.mp4');

let opts;
try {
  opts = parseSeedArgs(process.argv.slice(2));
} catch (e) {
  console.log(`[seed] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
if (!LOCAL) {
  console.log(
    '[seed] REFUSING - SITE is not this machine, and this writes content members would read'
  );
  process.exit(1);
}

const owner = userIdOf(OWNER_NAME);
const peer = userIdOf(PEER_NAME);
if (!owner || !peer) {
  console.log(
    `[seed] REFUSING - owner ${owner ? 'ok' : 'UNRESOLVED'}, peer ${peer ? 'ok' : 'UNRESOLVED'}`
  );
  process.exit(1);
}

const count = (sql) => Number(psql(sql).trim() || '0');

/**
 * Runs `body` inside a client's page with `api(method, path, json)` and `upload(bytes)` in scope,
 * both authenticated the way the app is: one `POST /api/auth/refresh` with the HttpOnly cookie, then
 * `Authorization: Bearer`. A non-2xx answer THROWS with its status and text, so a refusal surfaces
 * as itself rather than as a missing id three steps later.
 */
async function inPage(cx, body, args = {}) {
  const raw = await evaluate(
    cx,
    `(async function () {
       var ARGS = ${JSON.stringify(args)};
       var r = await fetch(location.origin + '/api/auth/refresh', { method: 'POST', credentials: 'include' });
       if (!r.ok) return JSON.stringify({ error: 'refresh answered ' + r.status });
       var token = (await r.json()).access_token;
       async function api(method, path, json) {
         var init = { method: method, headers: { Authorization: 'Bearer ' + token } };
         if (json !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(json); }
         var g = await fetch(location.origin + path, init);
         var text = await g.text();
         if (!g.ok) throw new Error(method + ' ' + path + ' -> ' + g.status + ' ' + text.slice(0, 300));
         return text ? JSON.parse(text) : null;
       }
       function hex(b) { return Array.from(b).map(function (x) { return x.toString(16).padStart(2, '0'); }).join(''); }
       // THE SAME ENCRYPTION AS mediaCrypto.ts: a fresh AES-256-GCM key and a 12-byte IV per file,
       // both hex, the ciphertext uploaded and the key kept in the post that cites it.
       async function upload(bytes) {
         var key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
         var iv = crypto.getRandomValues(new Uint8Array(12));
         var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, bytes);
         var form = new FormData();
         form.append('file', new Blob([ct], { type: 'application/octet-stream' }), 'encrypted');
         form.append('retentionClass', 'archive');
         var u = await fetch(location.origin + '/api/media/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
         if (!u.ok) throw new Error('upload -> ' + u.status + ' ' + (await u.text()).slice(0, 300));
         var raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
         return { mediaId: (await u.json()).mediaId, key: hex(raw), iv: hex(iv) };
       }
       try {
         return JSON.stringify({ result: await (async function () { ${body} })() });
       } catch (e) {
         return JSON.stringify({ error: String(e && e.message || e) });
       }
     })()`,
    { awaitPromise: true }
  );
  const out = JSON.parse(raw);
  if (out.error) throw new Error(out.error);
  return out.result;
}

const report = [];
const failures = [];
let w1 = null;
let w2 = null;
const W1 = async () => (w1 ??= await client(PORTS.W1));
const W2 = async () => (w2 ??= await client(PORTS.W2));

/** Runs one part, catching its failure so the others still run - and the exit code still says so. */
async function part(name, fn) {
  if (!opts.only.includes(name)) return;
  try {
    report.push(`${name}: ${await fn()}`);
  } catch (e) {
    const said = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${said}`);
    console.log(`[seed] ${name} FAILED - ${said}`);
  }
}

await part('posts', async () => {
  const have = count(
    `SELECT count(*) FROM posts WHERE "authorId" = '${owner}' AND markdown LIKE '%${MARK}%' AND images::text NOT LIKE '%video%'`
  );
  const owed = Math.max(0, opts.posts - have);
  if (owed === 0 || opts.dry)
    return `${have} held, ${owed} owed${opts.dry && owed ? ' (dry)' : ''}`;
  const made = await inPage(
    await W1(),
    `var n = 0;
     for (var i = ARGS.from; i < ARGS.to; i++) {
       await api('POST', '/api/posts', { markdown: 'Publication de banc no ' + (i + 1) + '\\n\\nDe quoi faire defiler le fil. ' + ARGS.mark });
       n++;
     }
     return n;`,
    { from: have, to: opts.posts, mark: MARK }
  );
  return `${have} held, ${made} created`;
});

await part('video', async () => {
  const have = count(
    `SELECT count(*) FROM posts WHERE "authorId" = '${owner}' AND markdown LIKE '%${MARK}%' AND images::text LIKE '%video%'`
  );
  if (have > 0 || opts.dry) return `${have} held${opts.dry && !have ? ', 1 owed (dry)' : ''}`;
  const bytes = readFileSync(VIDEO);
  const id = await inPage(
    await W1(),
    `var bin = atob(ARGS.b64);
     var bytes = new Uint8Array(bin.length);
     for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
     var ref = await upload(bytes);
     var post = await api('POST', '/api/posts', {
       markdown: 'Video de banc - lecture dans le fil. ' + ARGS.mark,
       media: [{ type: 'video', mediaId: ref.mediaId, key: ref.key, iv: ref.iv, mimeType: 'video/mp4',
                 size: bytes.length, fileName: 'bench-video.mp4', width: 360, height: 640 }]
     });
     return post && post.id;`,
    { b64: bytes.toString('base64'), mark: MARK }
  );
  return `created ${String(id).slice(0, 8)} (${bytes.length} B, encrypted upload)`;
});

await part('events', async () => {
  let assoc = psql(`SELECT id FROM associations WHERE slug = '${ASSOCIATION.slug}'`).trim();
  const upcoming = assoc
    ? count(
        `SELECT count(*) FROM association_calendar_events WHERE "associationId" = '${assoc}' AND title LIKE '${MARK}%' AND status = 'validated' AND "startsAt" > now()`
      )
    : 0;
  const owed = Math.max(0, opts.events - upcoming);
  if (owed === 0 || opts.dry) {
    return `association ${assoc ? 'held' : 'MISSING'}, ${upcoming} upcoming, ${owed} owed${opts.dry && owed ? ' (dry)' : ''}`;
  }
  const made = await inPage(
    await W2(),
    `var id = ARGS.assoc;
     if (!id) id = (await api('POST', '/api/associations', { name: ARGS.name, slug: ARGS.slug,
       description: 'Association du banc de test local. ' + ARGS.mark })).id;
     var day = 24 * 3600 * 1000, made = 0;
     for (var i = 0; i < ARGS.owed; i++) {
       // One every two days from tomorrow, at 18:00 local, two hours long: a fortnight of agenda.
       var start = new Date(Date.now() + (1 + 2 * (ARGS.upcoming + i)) * day);
       start.setHours(18, 0, 0, 0);
       var ev = await api('POST', '/api/associations/' + id + '/events', {
         title: ARGS.mark + ' Soiree de banc no ' + (ARGS.upcoming + i + 1),
         description: 'Evenement de banc pour l agenda.',
         startsAt: start.toISOString(),
         endsAt: new Date(start.getTime() + 2 * 3600 * 1000).toISOString()
       });
       // EVERY CREATE LANDS PENDING, a global admin's included; only a validated event is public.
       await api('POST', '/api/associations/' + id + '/events/' + ev.id + '/validate');
       made++;
     }
     return made;`,
    {
      assoc: assoc || null,
      name: ASSOCIATION.name,
      slug: ASSOCIATION.slug,
      owed,
      upcoming,
      mark: MARK,
    }
  );
  assoc = psql(`SELECT id FROM associations WHERE slug = '${ASSOCIATION.slug}'`).trim();
  return `association ${assoc.slice(0, 8)}, ${upcoming} upcoming held, ${made} created and validated`;
});

await part('salon', async () => {
  const workspaceId = workspaceIdOf(VENUE.community, { memberUserId: owner });
  if (!workspaceId)
    throw new Error(`no "${VENUE.community}" that ${OWNER_NAME} is in - run bun venue.mjs first`);
  let channelId = channelIdOf(workspaceId, SALON);
  const have = channelId ? channelMessageCount(channelId) : 0;
  const owed = Math.max(0, opts.messages - have);
  if (owed === 0 || opts.dry) {
    return `"${SALON}" ${channelId ? 'held' : 'MISSING'}, ${have} message(s), ${owed} owed${opts.dry && owed ? ' (dry)' : ''}`;
  }
  const cx = await W1();
  if (!channelId) {
    await enterCommunities(cx);
    await openCommunity(cx, VENUE.community);
    await createChannel(cx, SALON, { visibility: 'public' });
    channelId = channelIdOf(workspaceId, SALON);
    if (!channelId) throw new Error(`created "${SALON}" on screen, but no channel row names it`);
  }
  await openChannel(cx, VENUE.community, SALON);
  for (let i = have; i < opts.messages; i++) {
    await send(cx, `Message de banc no ${i + 1} - de quoi remonter le fil`);
    if ((i + 1) % 25 === 0) console.log(`[seed] salon: ${i + 1}/${opts.messages} sent`);
  }
  // THE TABLE IS THE VERDICT: the composer emptying proves a click, the row proves a message.
  const now = channelMessageCount(channelId);
  if (now < opts.messages)
    throw new Error(`sent ${owed}, but the channel holds ${now} of ${opts.messages}`);
  return `"${SALON}" ${channelId.slice(0, 8)}, ${have} held, now ${now}`;
});

for (const line of report) console.log(`[seed] ${line}`);
for (const f of failures) console.log(`[seed] FAILED ${f}`);
w1?.close();
w2?.close();
process.exit(failures.length ? 1 : 0);
