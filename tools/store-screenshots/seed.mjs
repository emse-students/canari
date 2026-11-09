#!/usr/bin/env bun
/**
 * The non-MLS half of the demo content on DEV: display names of the bench accounts, four invented
 * extra people, three generic associations with the bench accounts as officers, their posts (one
 * with a poll and votes), their events, and the follows that make them the feed of the demo account.
 *
 *   bun seed.mjs sql                 print the SQL (pure, no network)
 *   bun seed.mjs apply               run it on the dev database (idempotent: ON CONFLICT DO NOTHING / UPDATE)
 *   bun seed.mjs teardown            delete exactly the rows this script created (an allowlist of ids, never a pattern)
 *   bun seed.mjs status              count the rows that exist
 *
 * DEV ONLY by construction: the database is reached through the rig's `devPsqlCommand`, which refuses
 * anything but the single running container of the canari-dev compose project. The rig's machine-local
 * `names.mjs` names the ssh alias; nothing about the host is in this file.
 *
 * Display names are re-synced from the identity provider at each sign-in (core-service users.service),
 * so a bench account that signs in again gets its "Canari Test ..." name back: run `apply` again, and
 * `bun shots.mjs verify` catches it before a set is composed.
 *
 * Conversations and communities are MLS state and are created by live clients (`chat-seed.mjs`).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const q = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const uuid = (key) => {
  const h = createHash('sha256').update(`canari-store-shots:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const userId = (key) => createHash('sha256').update(`canari-store-shots:user:${key}`).digest('hex');
const at = (days, hour) => `date_trunc('day', now()) + interval '${days} days ${hour} hours'`;
const ago = (days, hours = 0) => `now() - interval '${days} days ${hours} hours'`;

/** The four bench accounts take these names, by their rig key (docs: test-accounts.json keys, never ids). */
export const BENCH = { third: 'Lina', owner: 'Mathis', peer: 'Sana', fourth: 'Tom' };
const EXTRA = ['Jade', 'Yanis', 'Léa', 'Noah'];

/** Next occurrence of a weekday (0 = Sunday) as a number of days from today, never today. */
const nextDay = (weekday, today = new Date()) => ((weekday - today.getDay() + 7) % 7) || 7;

/** The SQL of the whole seed. `benchIds` maps a rig key to the account's user id (read from the rig's state, never printed). */
export function buildSql(benchIds, today = new Date(), lang = 'fr') {
  const en = lang === 'en';
  /** The ids of the language-specific rows: the English ones are their own rows, so both sets can exist and one be set aside. */
  const lk = (key) => (en ? `${key}:en` : key);
  const wed = nextDay(3, today), thu = nextDay(4, today), fri = nextDay(5, today), sat = nextDay(6, today);
  const ids = { ...benchIds };
  for (const n of EXTRA) ids[n] = userId(n);
  const lina = ids.third, hugo = ids.owner, sana = ids.peer, tom = ids.fourth;
  const voters = [lina, hugo, sana, tom, ...EXTRA.map((n) => ids[n])];
  const assos = [
    { key: 'bde', name: 'Bureau des élèves', color: '#2563eb', president: hugo, description: "L'équipe qui organise la semaine d'intégration et la soirée du vendredi." },
    { key: 'photo', name: 'Club photo', color: '#7c3aed', president: sana, description: 'Sorties, ateliers et expo photo, pour tous les niveaux.' },
    { key: 'rando', name: 'Club randonnée', color: '#16a34a', president: tom, description: 'Une sortie par mois autour de la ville.' },
  ];
  const aid = (k) => uuid(`association:${k}`);
  const poll = {
    id: uuid(lk('poll:theme')),
    question: en ? 'Which theme for the party?' : 'Quel thème pour la soirée ?',
    options: [
      { id: uuid(lk('poll:theme:80')), label: en ? '80s' : 'Années 80', votes: [] },
      { id: uuid(lk('poll:theme:pyjama')), label: en ? 'Pyjamas' : 'Pyjama', votes: [] },
      { id: uuid(lk('poll:theme:neon')), label: en ? 'Neon' : 'Néon', votes: [] },
    ],
    multipleChoice: false,
    anonymous: false,
    votesByUser: {},
  };
  // 4 for the 80s, 2 for pyjama, 2 for neon: a readable result.
  voters.forEach((v, i) => {
    const o = poll.options[i < 4 ? 0 : i < 6 ? 1 : 2];
    o.votes.push(v);
    poll.votesByUser[v] = [o.id];
  });
  const posts = [
    {
      key: lk('theme'), author: hugo, as: 'bde', ago: [0, 0.05], polls: [poll],
      md: en ? 'The integration party is coming up: **vote for the theme** and come along on Friday at 8 pm!' : "La soirée d'intégration approche : **votez pour le thème** et venez nombreux vendredi à 20 h !",
    },
    {
      key: lk('photo'), author: sana, as: 'photo', ago: [1, 2],
      md: en ? "We'll take the pictures at Friday's party. Come and see us at Wednesday's workshop, camera or phone." : "On fera les photos de la soirée vendredi. Passez nous voir pour l'atelier de mercredi, appareil ou téléphone.",
    },
    {
      key: lk('rando'), author: tom, as: 'rando', ago: [2, 5],
      md: en ? 'Hike on Saturday, leaving at 9 am in front of the school. Walking shoes and good spirits.' : "Sortie rando samedi, départ 9 h devant l'école. Chaussures de marche et bonne humeur.",
    },
  ];
  const events = [
    { key: lk('atelier'), as: 'photo', author: sana, title: en ? 'Photo workshop' : 'Atelier photo', days: wed, hour: 18 },
    { key: lk('diner'), as: 'bde', author: hugo, title: en ? 'Weekly dinner' : 'Dîner de la semaine', days: thu, hour: 19 },
    { key: lk('soiree'), as: 'bde', author: hugo, title: en ? 'Integration party' : "Soirée d'intégration", days: fri, hour: 20 },
    { key: lk('rando'), as: 'rando', author: tom, title: en ? 'Hike' : 'Randonnée', days: sat, hour: 9 },
  ];
  const out = ['BEGIN;'];
  // The bench accounts' names (an UPDATE by id: the rows exist, the accounts signed in once).
  for (const [k, name] of Object.entries(BENCH))
    out.push(`UPDATE "users" SET "displayName" = ${q(name)}, "firstName" = ${q(name)}, "lastName" = NULL WHERE "id" = ${q(benchIds[k])};`);
  out.push(
    `INSERT INTO "users" ("id", "displayName", "firstName", "lastName", "promo", "formation", "campus", "cursus", "bio", "createdAt", "updatedAt") VALUES\n` +
      EXTRA.map((n) => `  (${q(ids[n])}, ${q(n)}, ${q(n)}, NULL, 2024, 'ICM', 'saint-etienne', '[{"formation":"ICM","promo":2024}]'::jsonb, NULL, ${ago(20)}, ${ago(20)})`).join(',\n') +
      '\nON CONFLICT ("id") DO NOTHING;',
  );
  out.push(
    `INSERT INTO "associations" ("id", "name", "slug", "description", "color", "type", "promo", "contactEmail", "createdBy") VALUES\n` +
      assos.map((a) => `  (${q(aid(a.key))}, ${q(a.name)}, ${q(`demo-${a.key}`)}, ${q(a.description)}, ${q(a.color)}, 'association', NULL, 'bureau.${a.key}@example.invalid', ${q(a.president)})`).join(',\n') +
      '\nON CONFLICT ("id") DO NOTHING;',
  );
  out.push(
    `INSERT INTO "association_audiences" ("id", "associationId", "formation", "campus") VALUES\n` +
      assos.map((a) => `  (${q(uuid(`audience:${a.key}`))}, ${q(aid(a.key))}, NULL, 'saint-etienne')`).join(',\n') +
      '\nON CONFLICT ("id") DO NOTHING;',
  );
  // Officers: the president holds every flag (8191 is the dev seed's value for "all"); the other bench accounts are members.
  const members = assos.flatMap((a) =>
    [lina, hugo, sana, tom].map((u, i) => ({ a, u, president: u === a.president, i })),
  );
  out.push(
    `INSERT INTO "association_members" ("id", "associationId", "userId", "role", "permissions", "sortOrder") VALUES\n` +
      members.map((m) => `  (${q(uuid(`member:${m.a.key}:${m.u}`))}, ${q(aid(m.a.key))}, ${q(m.u)}, ${q(m.president ? 'President' : 'Membre')}, ${m.president ? 8191 : 0}, ${m.president ? 0 : m.i + 1})`).join(',\n') +
      '\nON CONFLICT ("id") DO NOTHING;',
  );
  out.push(
    `INSERT INTO "association_follows" ("id", "followerUserId", "associationId") VALUES\n` +
      assos.flatMap((a) => [lina, hugo, sana, tom].map((u) => `  (${q(uuid(`follow:${a.key}:${u}`))}, ${q(u)}, ${q(aid(a.key))})`)).join(',\n') +
      '\nON CONFLICT ("id") DO NOTHING;',
  );
  out.push(
    `INSERT INTO "association_calendar_events" ("id", "associationId", "title", "description", "startsAt", "endsAt", "createdBy", "kind", "status", "validatedAt", "validatedBy") VALUES\n` +
      events.map((e) => `  (${q(uuid(`event:${e.key}`))}, ${q(aid(e.as))}, ${q(e.title)}, ${q('Semaine d\'intégration.')}, ${at(e.days, e.hour)}, ${at(e.days, e.hour + 2)}, ${q(e.author)}, 'event', 'validated', ${ago(1)}, ${q(assos.find((a) => a.key === e.as).president)})`).join(',\n') +
      '\nON CONFLICT ("id") DO NOTHING;',
  );
  out.push(
    `INSERT INTO "posts" ("id", "authorId", "markdown", "associationId", "polls", "createdAt", "publishedAt") VALUES\n` +
      posts.map((p) => `  (${q(uuid(`post:${p.key}`))}, ${q(p.author)}, ${q(p.md)}, ${q(aid(p.as))}, ${q(JSON.stringify(p.polls ?? []))}::jsonb, ${ago(...p.ago)}, ${ago(...p.ago)})`).join(',\n') +
      '\nON CONFLICT ("id") DO NOTHING;',
  );
  out.push('COMMIT;');
  return out.join('\n');
}

/** Delete exactly what `buildSql` created (extra users included), children first. Allowlist of derived ids. */
export function teardownSql(benchIds) {
  const sql = ['fr', 'en'].map((l) => buildSql(benchIds, new Date(), l)).join('\n');
  const idsOf = (table) => [...new Set([...sql.matchAll(new RegExp(`INSERT INTO "${table}"[^;]*?;`, 'gs'))].flatMap((m) => [...m[0].matchAll(/^  \('([^']+)'/gm)].map((x) => x[1])))];
  const list = (t) => idsOf(t).map(q).join(',');
  return ['BEGIN;', ...['posts', 'association_calendar_events', 'association_follows', 'association_members', 'association_audiences', 'associations', 'users'].map((t) => `DELETE FROM "${t}" WHERE "id" IN (${list(t)});`), 'COMMIT;'].join('\n');
}

/**
 * Sets aside, REVERSIBLY, the language-specific rows of one language: its events become `rejected`
 * and its posts `hiddenByModeration`, by the derived ids only (an allowlist, never a pattern). The
 * other language is unset again by `restoreSql`. Used between the French pass and the English one,
 * so a capture shows one language's content.
 */
export function setAsideSql(benchIds, lang) {
  const sql = buildSql(benchIds, new Date(), lang);
  const ids = (t) => [...sql.matchAll(new RegExp(`INSERT INTO "${t}"[^;]*?;`, 'gs'))].flatMap((m) => [...m[0].matchAll(/^  \('([^']+)'/gm)].map((x) => q(x[1]))).join(',');
  return `UPDATE "association_calendar_events" SET "status" = 'rejected', "rejectedAt" = now(), "rejectionReason" = 'store-shots: set aside for the other language' WHERE "id" IN (${ids('association_calendar_events')});\n` +
    `UPDATE "posts" SET "hiddenByModeration" = true WHERE "id" IN (${ids('posts')});`;
}

/** Undoes `setAsideSql` for one language. */
export function restoreSql(benchIds, lang) {
  const sql = buildSql(benchIds, new Date(), lang);
  const ids = (t) => [...sql.matchAll(new RegExp(`INSERT INTO "${t}"[^;]*?;`, 'gs'))].flatMap((m) => [...m[0].matchAll(/^  \('([^']+)'/gm)].map((x) => q(x[1]))).join(',');
  return `UPDATE "association_calendar_events" SET "status" = 'validated', "rejectedAt" = NULL, "rejectionReason" = NULL WHERE "id" IN (${ids('association_calendar_events')});\n` +
    `UPDATE "posts" SET "hiddenByModeration" = false WHERE "id" IN (${ids('posts')});`;
}

if (import.meta.main) {
  const cmd = process.argv[2];
  const { accounts } = JSON.parse(readFileSync(join('F:/Programmation/canari-harness', 'test-accounts.json'), 'utf8'));
  const benchIds = Object.fromEntries(Object.keys(BENCH).map((k) => [k, accounts[k].sub]));
  const langArg = process.argv.includes('--lang') ? process.argv[process.argv.indexOf('--lang') + 1] : 'fr';
  if (cmd === 'sql') console.log(buildSql(benchIds, new Date(), langArg));
  else if (['apply', 'teardown', 'status', 'setaside', 'restore'].includes(cmd)) {
    const { ssh } = await import('../cross-client-harness/ssh.mjs');
    const { devPsqlCommand } = await import('../cross-client-harness/estate-target.mjs');
    const { DEV_SSH_HOST } = await import('../cross-client-harness/names.mjs');
    const run = (sql) => ssh(DEV_SSH_HOST, devPsqlCommand(sql));
    if (cmd === 'apply') console.log(run(buildSql(benchIds, new Date(), langArg)));
    else if (cmd === 'setaside') console.log(run(setAsideSql(benchIds, langArg)));
    else if (cmd === 'restore') console.log(run(restoreSql(benchIds, langArg)));
    else if (cmd === 'teardown') console.log(run(teardownSql(benchIds)));
    else console.log(run(`select (select count(*) from associations where slug like 'demo-%') as associations, (select count(*) from posts where id in (${[...buildSql(benchIds).matchAll(/^  \('([^']+)', '[0-9a-f]{64}', '(?:[^']|'')*', '[0-9a-f-]{36}', '\[/gm)].map((m) => q(m[1])).join(',') || "''"})) as posts`));
  } else {
    console.error('usage: bun seed.mjs sql|apply|teardown|status|setaside|restore [--lang fr|en]');
    process.exit(2);
  }
}
