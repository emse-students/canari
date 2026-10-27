#!/usr/bin/env bun
/**
 * THE DEV ESTATE'S DATA: FICTIONAL PEOPLE, FICTIONAL ASSOCIATIONS, AND NOTHING COPIED FROM ANYONE.
 *
 * WHY IT EXISTS (owner, 2026-10-16, GDPR review). `dev.canari-emse.fr` used to be loaded with a
 * `pg_dump` of production every Monday - every member's name, profile, posts, memberships and
 * calendar - onto a second, publicly resolvable estate that exists to run unreleased code. That
 * copy is gone, with no flag to bring it back. This module is what replaced it: a small, readable,
 * DETERMINISTIC data set whose every person is visibly invented.
 *
 * WHAT IT SEEDS AND WHAT IT DELIBERATELY DOES NOT.
 *   - Seeded: users, the ten spaces, association categories, associations (one BDE, clubs, a list,
 *     an institution), their audiences, memberships, follows, posts and calendar events - the
 *     plaintext surfaces a tester opens first.
 *   - NOT seeded: communities, salons, DMs and anything else under MLS. A community inserted as
 *     rows has no key-distribution group and no device holding its state, so it is a community
 *     nobody can ever read (`channel.service.ts` refuses to create one without the group, and
 *     `durable-rules.md` records the same fact for the campaign venue). Testers create those
 *     through the product, which is the only path that creates them correctly.
 *   - NOT seeded: media. A row naming an object the dev bucket does not hold renders as a 404.
 *
 * HOW A ROW IS FAKE, CHECKABLY. Every person's last name is `SEED_MARKER`; every association name
 * carries `Fictif`/`Fictive`; every address is on `example.invalid`, the TLD RFC 2606 reserves so
 * that it can never resolve (`example.org` would - IANA serves it). User ids are 64 hex characters
 * because mentions match that shape (`MENTION_USER_ID_PATTERN`), and they are sha256 of a public
 * string so anyone can re-derive them; no real OIDC subject can collide with one in practice.
 *
 * DETERMINISM. No clock and no random source: ids come from sha256 over stable keys, and every time
 * is a SQL expression relative to `now()` (a post from "two days ago" stays two days old whenever
 * the reset runs). `seed.test.ts` renders twice and compares, and compares the render with the
 * committed `infrastructure/dev/seed.sql` - which is what the reset script loads, so the box needs
 * no bun at all.
 *
 * Usage:
 *   bun tools/dev-seed/seed.ts           # print the SQL
 *   bun tools/dev-seed/seed.ts --write   # regenerate infrastructure/dev/seed.sql
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { associationPermissionBits } from './entities';

/** The repository root, resolved from this file so the CLI works from any working directory. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where the rendered SQL is committed, and where `reset-dev-to-seed.sh` reads it from. */
export const SEED_SQL_PATH = 'infrastructure/dev/seed.sql';

/** Every seeded person's last name. The reset script verifies it on every `users` row it leaves. */
export const SEED_MARKER = 'Fictif';

/** The only e-mail domain the seed may write: RFC 2606 `.invalid`, never deliverable. */
export const SEED_EMAIL_DOMAIN = 'example.invalid';

/** A value as the seed writes it. `expr` is limited to the time helpers below, never free SQL. */
export type SqlValue = string | number | boolean | null | { json: unknown } | { expr: string };

/** One table's rows, in insertion order. Column order is the first row's key order. */
export type SeedRows = Record<string, Record<string, SqlValue>[]>;

/** sha256 of a stable key, as 64 lowercase hex characters - the shape of a hashed OIDC subject. */
export function userId(key: string): string {
  return createHash('sha256').update(`canari-dev-seed:user:${key}`).digest('hex');
}

/** A deterministic RFC 4122 version-4-shaped UUID derived from a stable key. */
export function uuid(key: string): string {
  const h = createHash('sha256').update(`canari-dev-seed:uuid:${key}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A time `days` (+ `hours`) before the reset, as SQL. */
export function ago(days: number, hours = 0): { expr: string } {
  return { expr: `now() - interval '${days} days ${hours} hours'` };
}

/** A time at `hour`:00 on the day `days` after the reset, as SQL - a calendar slot, not an instant. */
export function ahead(days: number, hour: number): { expr: string } {
  return { expr: `date_trunc('day', now()) + interval '${days} days ${hour} hours'` };
}

/** The fictional people. `key` is the stable identity; the names are what a screen shows. */
/**
 * The client floor dev is reset to. It must follow the PRODUCTION floor (the server refuses a floor
 * above its own version, so never raise it past what dev runs). The live row is changed from the
 * admin page; this constant is only what a reset-to-seed drops it back to.
 */
const MIN_CLIENT_VERSION = '1.2.7';

const PEOPLE = [
  { key: 'alice', first: 'Alice', formation: 'ICM', promo: 2024, campus: 'saint-etienne' },
  { key: 'bruno', first: 'Bruno', formation: 'ICM', promo: 2023, campus: 'saint-etienne' },
  { key: 'chloe', first: 'Chloe', formation: 'ICM', promo: 2025, campus: 'saint-etienne' },
  { key: 'david', first: 'David', formation: 'ISMIN', promo: 2024, campus: 'gardanne' },
  { key: 'emma', first: 'Emma', formation: 'ISMIN', promo: 2025, campus: 'gardanne' },
  { key: 'farid', first: 'Farid', formation: 'FSSS', promo: 2024, campus: 'saint-etienne' },
  { key: 'gaelle', first: 'Gaelle', formation: 'PDIS', promo: 2022, campus: 'saint-etienne' },
  { key: 'hugo', first: 'Hugo', formation: 'Autre', promo: 2025, campus: 'gardanne' },
  { key: 'ines', first: 'Ines', formation: 'ICM', promo: 2026, campus: 'saint-etienne' },
  { key: 'jules', first: 'Jules', formation: 'ICM', promo: 2026, campus: 'saint-etienne' },
] as const;

type PersonKey = (typeof PEOPLE)[number]['key'];

/** Every formation x campus pair, as migration 071 creates them; the seed restores all ten. */
const FORMATIONS = ['ICM', 'ISMIN', 'FSSS', 'PDIS', 'Autre'] as const;
const CAMPUSES = ['saint-etienne', 'gardanne'] as const;

const CATEGORIES = [
  { key: 'sport', label: 'Sport', sortOrder: 0 },
  { key: 'culture', label: 'Culture', sortOrder: 1 },
  { key: 'vie', label: 'Vie etudiante', sortOrder: 2 },
] as const;

/**
 * The associations. `audience` is the rule set (`null` = any): the institution addresses everyone,
 * so a tester of any formation and campus sees at least its posts.
 */
const ASSOCIATIONS = [
  {
    key: 'bde',
    name: 'BDE Fictif',
    type: 'association',
    category: 'vie',
    color: '#2563eb',
    president: 'alice',
    members: ['bruno', 'chloe', 'ines'],
    audience: [['ICM', 'saint-etienne']],
    description: "Le bureau des eleves de demonstration. Rien de ce qui est ecrit ici n'est reel.",
  },
  {
    key: 'echecs',
    name: 'Club Echecs Fictif',
    type: 'association',
    category: 'culture',
    color: '#16a34a',
    president: 'bruno',
    members: ['farid', 'jules'],
    audience: [[null, 'saint-etienne']],
    description: 'Parties du mardi soir, tournoi fictif en fin de semestre.',
  },
  {
    key: 'fanfare',
    name: 'Fanfare Fictive',
    type: 'association',
    category: 'culture',
    color: '#db2777',
    president: 'gaelle',
    members: ['alice', 'hugo'],
    audience: [[null, null]],
    description: 'Cuivres, percussions et repetitions imaginaires.',
  },
  {
    key: 'escalade',
    name: 'Escalade Fictive Gardanne',
    type: 'association',
    category: 'sport',
    color: '#ea580c',
    president: 'david',
    members: ['emma', 'hugo'],
    audience: [[null, 'gardanne']],
    description: 'Sorties en salle et en falaise, toutes inventees.',
  },
  {
    key: 'liste',
    name: 'Liste Fictive 2026',
    type: 'list',
    category: null,
    color: '#7c3aed',
    president: 'ines',
    members: ['jules'],
    audience: [['ICM', 'saint-etienne']],
    description: 'Une liste de campagne de demonstration.',
  },
  {
    key: 'ecole',
    name: 'Ecole Fictive',
    type: 'institution',
    category: null,
    color: '#0f172a',
    president: 'gaelle',
    members: [],
    audience: [[null, null]],
    description: "L'institution de demonstration : ses publications s'adressent a tout le monde.",
  },
] as const;

type AssociationKey = (typeof ASSOCIATIONS)[number]['key'];

/** The feed, newest last in this list. `as` = the association it is published as, if any. */
const POSTS: {
  key: string;
  author: PersonKey;
  as: AssociationKey | null;
  daysAgo: number;
  markdown: string;
}[] = [
  {
    key: 'bienvenue',
    author: 'gaelle',
    as: 'ecole',
    daysAgo: 6,
    markdown:
      "**Bienvenue sur l'environnement de test.** Toutes les personnes, associations et publications que vous voyez ici sont fictives.",
  },
  {
    key: 'tournoi',
    author: 'bruno',
    as: 'echecs',
    daysAgo: 5,
    markdown: 'Tournoi fictif samedi prochain : inscrivez-vous aupres du bureau du club.',
  },
  {
    key: 'repet',
    author: 'gaelle',
    as: 'fanfare',
    daysAgo: 4,
    markdown: 'Repetition generale jeudi, salle imaginaire B12.',
  },
  {
    key: 'perso-alice',
    author: 'alice',
    as: null,
    daysAgo: 3,
    markdown: "Quelqu'un a vu mon parapluie fictif ? Il etait bleu.",
  },
  {
    key: 'soiree',
    author: 'alice',
    as: 'bde',
    daysAgo: 2,
    markdown: "La soiree d'integration fictive aura lieu vendredi. Tenue correcte exigee.",
  },
  {
    key: 'falaise',
    author: 'david',
    as: 'escalade',
    daysAgo: 2,
    markdown: 'Sortie falaise annulee pour cause de pluie fictive.',
  },
  {
    key: 'programme',
    author: 'ines',
    as: 'liste',
    daysAgo: 1,
    markdown: 'Notre programme fictif tient en trois mots : cafe, sommeil, partiels.',
  },
  {
    key: 'perso-hugo',
    author: 'hugo',
    as: null,
    daysAgo: 0,
    markdown: 'Premier message de test depuis Gardanne.',
  },
];

/** The calendar. One event stays `pending` so the validation flow has something to act on. */
const EVENTS: {
  key: string;
  association: AssociationKey;
  author: PersonKey;
  days: number;
  hour: number;
  title: string;
  status: 'validated' | 'pending';
}[] = [
  {
    key: 'tournoi',
    association: 'echecs',
    author: 'bruno',
    days: 5,
    hour: 14,
    title: 'Tournoi fictif',
    status: 'validated',
  },
  {
    key: 'soiree',
    association: 'bde',
    author: 'alice',
    days: 4,
    hour: 21,
    title: "Soiree d'integration fictive",
    status: 'validated',
  },
  {
    key: 'concert',
    association: 'fanfare',
    author: 'gaelle',
    days: 10,
    hour: 19,
    title: 'Concert imaginaire',
    status: 'validated',
  },
  {
    key: 'salle',
    association: 'escalade',
    author: 'david',
    days: 2,
    hour: 18,
    title: 'Seance en salle',
    status: 'validated',
  },
  {
    key: 'debat',
    association: 'liste',
    author: 'ines',
    days: 7,
    hour: 12,
    title: 'Debat de campagne fictif',
    status: 'pending',
  },
];

/** Who follows what - enough for a follow list and a follower count to render non-empty. */
const ASSOCIATION_FOLLOWS: [PersonKey, AssociationKey][] = [
  ['chloe', 'echecs'],
  ['ines', 'fanfare'],
  ['jules', 'bde'],
  ['emma', 'fanfare'],
  ['farid', 'bde'],
];
const USER_FOLLOWS: [PersonKey, PersonKey][] = [
  ['alice', 'bruno'],
  ['bruno', 'alice'],
  ['chloe', 'alice'],
  ['emma', 'david'],
];

/** Builds every row the seed writes, keyed by table, in an order that satisfies the foreign keys. */
export function buildSeed(repoRoot: string = REPO_ROOT): SeedRows {
  // Every flag the enum declares, so a president can exercise every permission screen.
  const allPermissions = 2 ** associationPermissionBits(repoRoot) - 1;
  const assoId = (key: AssociationKey) => uuid(`association:${key}`);

  const users = PEOPLE.map((p) => ({
    id: userId(p.key),
    displayName: `${p.first} ${SEED_MARKER}`,
    firstName: p.first,
    lastName: SEED_MARKER,
    promo: p.promo,
    formation: p.formation,
    campus: p.campus,
    cursus: { json: [{ formation: p.formation, promo: p.promo }] },
    bio: `Personne fictive de l'environnement de test (${p.formation} ${p.promo}).`,
    createdAt: ago(30),
    updatedAt: ago(30),
  }));

  const categories = CATEGORIES.map((c) => ({
    id: uuid(`category:${c.key}`),
    label: c.label,
    slug: c.key,
    sortOrder: c.sortOrder,
  }));

  const associations = ASSOCIATIONS.map((a) => ({
    id: assoId(a.key),
    name: a.name,
    slug: `${a.key}-fictif`,
    description: a.description,
    color: a.color,
    categoryId: a.category ? uuid(`category:${a.category}`) : null,
    type: a.type,
    promo: a.type === 'list' ? 2026 : null,
    contactEmail: `bureau.${a.key}@${SEED_EMAIL_DOMAIN}`,
    createdBy: userId(a.president),
  }));

  const audiences = ASSOCIATIONS.flatMap((a) =>
    a.audience.map(([formation, campus]) => ({
      id: uuid(`audience:${a.key}:${formation ?? '*'}:${campus ?? '*'}`),
      associationId: assoId(a.key),
      formation,
      campus,
    }))
  );

  const spaces = FORMATIONS.flatMap((formation) =>
    CAMPUSES.map((campus) => ({
      id: uuid(`space:${formation}:${campus}`),
      formation,
      campus,
      // The BDE governs the one space the production seed of migration 071 gave a BDE.
      bdeAssociationId: formation === 'ICM' && campus === 'saint-etienne' ? assoId('bde') : null,
    }))
  );

  const members = ASSOCIATIONS.flatMap((a) => [
    {
      id: uuid(`member:${a.key}:${a.president}`),
      associationId: assoId(a.key),
      userId: userId(a.president),
      role: 'President',
      permissions: allPermissions,
      sortOrder: 0,
    },
    ...a.members.map((m, i) => ({
      id: uuid(`member:${a.key}:${m}`),
      associationId: assoId(a.key),
      userId: userId(m),
      role: 'Membre',
      permissions: 0,
      sortOrder: i + 1,
    })),
  ]);

  const associationFollows = ASSOCIATION_FOLLOWS.map(([who, what]) => ({
    id: uuid(`follow:${who}:${what}`),
    followerUserId: userId(who),
    associationId: assoId(what),
  }));

  const userFollows = USER_FOLLOWS.map(([who, whom]) => ({
    id: uuid(`user-follow:${who}:${whom}`),
    followerUserId: userId(who),
    followedUserId: userId(whom),
    // Written, never defaulted: the column's default is a pending REQUEST (migration 112), and a
    // seeded follow is meant to be one.
    status: 'accepted',
  }));

  const events = EVENTS.map((e) => ({
    id: uuid(`event:${e.key}`),
    associationId: assoId(e.association),
    title: e.title,
    description: `Evenement fictif organise par ${ASSOCIATIONS.find((a) => a.key === e.association)?.name}.`,
    startsAt: ahead(e.days, e.hour),
    endsAt: ahead(e.days, e.hour + 2),
    createdBy: userId(e.author),
    kind: 'event',
    status: e.status,
    // A validated event names its validator: the BDE president, who holds every flag.
    validatedAt: e.status === 'validated' ? ago(1) : null,
    validatedBy: e.status === 'validated' ? userId('alice') : null,
  }));

  const posts = POSTS.map((p) => ({
    id: uuid(`post:${p.key}`),
    authorId: userId(p.author),
    markdown: p.markdown,
    associationId: p.as ? assoId(p.as) : null,
    createdAt: ago(p.daysAgo, 2),
    publishedAt: ago(p.daysAgo, 2),
  }));

  return {
    platform_config: [
      // `disabled` because dev reaches no payment provider by default; Lydia's homologation pair
      // can be switched on from the admin page, which is the tester's own gesture.
      {
        id: 1,
        maintenance_enabled: false,
        min_client_version: MIN_CLIENT_VERSION,
        payment_provider: 'disabled',
        // Dev is where calls are read on the bench phones, video included, so its kill switch
        // (migration 014) is open; production's row defaults to `off`.
        calls_mode: 'audio_video',
        // Dev is where lives are read on the bench phones, so its lives kill switch (migration 015)
        // is open too; production's row defaults to `off`.
        lives_mode: 'on',
      },
    ],
    users,
    association_categories: categories,
    associations,
    association_audiences: audiences,
    spaces,
    association_members: members,
    association_follows: associationFollows,
    user_follows: userFollows,
    association_calendar_events: events,
    posts,
  };
}

/** One value as a SQL literal. Strings are single-quoted with quotes doubled; nothing else escapes. */
export function sqlLiteral(value: SqlValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number in the seed: ${value}`);
    return String(value);
  }
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if ('json' in value) return `'${JSON.stringify(value.json).replace(/'/g, "''")}'::jsonb`;
  return value.expr;
}

/** The SQL file the reset loads: a header the script parses, then one INSERT per table. */
export function renderSql(rows: SeedRows): string {
  const tables = Object.keys(rows);
  const lines = [
    '-- The dev.canari-emse.fr seed: fictional people and associations, nothing copied from production.',
    '-- GENERATED by tools/dev-seed/seed.ts - edit that file and run `bun tools/dev-seed/seed.ts --write`.',
    '-- Loaded by infrastructure/dev/reset-dev-to-seed.sh inside the same transaction as its TRUNCATE,',
    '-- so this file carries no transaction control of its own. The three lines below are read by it.',
    `-- seed-users: ${rows.users?.length ?? 0}`,
    `-- seed-marker: ${SEED_MARKER}`,
    `-- seed-tables: ${tables.join(' ')}`,
    '',
  ];
  for (const table of tables) {
    const list = rows[table];
    if (list.length === 0) continue;
    const columns = Object.keys(list[0]);
    for (const row of list) {
      const keys = Object.keys(row);
      if (keys.join(',') !== columns.join(',')) {
        throw new Error(`${table}: every row must name the same columns in the same order`);
      }
    }
    lines.push(`INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES`);
    list.forEach((row, i) => {
      const values = columns.map((c) => sqlLiteral(row[c])).join(', ');
      lines.push(`  (${values})${i === list.length - 1 ? ';' : ','}`);
    });
    lines.push('');
  }
  return lines.join('\n');
}

if (import.meta.main) {
  const sql = renderSql(buildSeed());
  if (process.argv.includes('--write')) {
    writeFileSync(join(REPO_ROOT, SEED_SQL_PATH), sql);
    console.log(`[dev-seed] wrote ${SEED_SQL_PATH}`);
  } else {
    process.stdout.write(sql);
  }
}
