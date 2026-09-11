/**
 * Loads a legacy estate's cotisants into the `legacy_cotisations` staging table, where each row
 * waits for its holder to sign into Canari (see migration 059 and `docs/wiki/cotisations.md`).
 *
 * One-shot, run by hand, never on a schedule: both sources are frozen exports of systems Canari
 * replaced. Re-running it is safe - a row already staged is skipped, not duplicated.
 *
 *   bun scripts/import-legacy-cotisations.ts --source bde    --file "Liste cotisants 25_26.xlsx" --promo-1a 2025
 *   bun scripts/import-legacy-cotisations.ts --source cercle --file legacy-readonly-backup.db \
 *       --repair-names promo.csv
 *
 * `--repair-names` takes a directory export with intact accents. Le Cercle's legacy base has none:
 * every accent was destroyed before the export and replaced by `?`, so without it 150 of its 1169
 * cotisants are refused rather than staged under a key no sign-in could match.
 *
 * Add --dry-run to parse, check and report without writing. Database connection comes from the
 * same DB_* variables the service reads.
 *
 * `--emit-sql <path>` writes the load as one idempotent transaction instead of connecting, for the
 * deployed estates: neither database container publishes a port, and the way in is `docker exec ...
 * psql` from the box (`docs/wiki/infrastructure/databases.md`). The emitted file NAMES REAL PEOPLE
 * and must not be committed - a path outside the repository, then:
 *
 *   bun scripts/import-legacy-cotisations.ts --source cercle --file ... --emit-sql /tmp/cercle.sql
 *   ssh canari 'docker exec -i infrastructure-postgres-1 psql -U canari -d auth_db -v ON_ERROR_STOP=1' \
 *     < /tmp/cercle.sql
 */
import { readFileSync, writeFileSync } from 'fs';
import { Client } from 'pg';
import { Database } from 'bun:sqlite';
import ExcelJS from 'exceljs';
import { normalizeMatchKey } from '../src/users/legacy-cotisation.util';
import { renderLegacyCotisationSql } from '../src/users/legacy-cotisation-sql';

/** One cotisant resolved from a source, before it is staged. */
interface Candidate {
  matchKey: string;
  sourceLabel: string;
  metadata: Record<string, unknown>;
}

/** The legacy Cercle consommable that IS the cotisation. Asserted by name before anything is read. */
const CERCLE_COTISATION_CONSOMMABLE_ID = 2;
const CERCLE_COTISATION_NAME = 'Cotisation Cercle';

/**
 * Le Cercle sold ONE cotisation before Canari, and it carried alcohol; the avec/sans-alcool split
 * post-dates the whole legacy estate. The nominal price only tracks inflation (26 EUR from 2017,
 * 30 EUR from 2023) and must NOT be used to infer a tier - filtering on it would silently drop
 * two thirds of the roster.
 */
const CERCLE_VARIANT_KEY = 'avec-alcool';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** One person in the reference directory used to repair names whose accents were destroyed. */
interface ReferenceName {
  first: string;
  last: string;
  promo: number;
}

function deaccent(value: string, keepQuestionMarks = false): string {
  return value
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(keepQuestionMarks ? /[^a-z0-9?]+/g : /[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Loads a `"id","login","email","first_name","last_name","promo",...` directory export, used only
 * to repair names. Accents are kept: repairing a destroyed one is the whole point.
 */
function loadNameReference(file: string): ReferenceName[] {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(1);
  const out: ReferenceName[] = [];
  for (const line of lines) {
    const m = line.match(/^"(.*?)","(.*?)","(.*?)","(.*?)","(.*?)","(.*?)"/);
    if (!m) continue;
    const promo = Number(m[6]);
    if (!Number.isInteger(promo)) continue;
    out.push({ first: deaccent(m[4]!), last: deaccent(m[5]!), promo });
  }
  return out;
}

/**
 * Turns a name whose accents became `?` into an anchored pattern: two `?` stood for one 2-byte
 * UTF-8 character, so they collapse to a single wildcard.
 */
function toRepairPattern(value: string): RegExp {
  const d = deaccent(value, true);
  let out = '';
  let i = 0;
  while (i < d.length) {
    if (d[i] === '?') {
      let run = 0;
      while (i < d.length && d[i] === '?') {
        run++;
        i++;
      }
      out += '.'.repeat(Math.max(1, Math.round(run / 2)));
    } else {
      out += d[i]!.replace(/[.*+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Recovers the real spelling of a name Le Cercle's legacy base mangled, by matching its pattern
 * against the reference directory for that promo.
 *
 * Only a UNIQUE match is accepted. Measured over the 150 damaged cotisants: 141 resolve to exactly
 * one person, 9 to none (rows whose name field holds a programme or a joke account), and - the
 * reason this is safe to automate - NONE to more than one.
 */
function repairName(
  lastName: string,
  firstName: string,
  promo: number,
  reference: ReferenceName[]
): { lastName: string; firstName: string } | null {
  const lastPattern = toRepairPattern(lastName);
  const firstPattern = toRepairPattern(firstName);
  const hits = reference.filter(
    (r) => r.promo === promo && lastPattern.test(r.last) && firstPattern.test(r.first)
  );
  return hits.length === 1 ? { lastName: hits[0]!.last, firstName: hits[0]!.first } : null;
}

/** Reads the BDE spreadsheet: three year-group blocks side by side, each `NOM | Prenom | Cotisation`. */
async function readBde(file: string, promo1A: number): Promise<Candidate[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error(`${file}: no worksheet`);

  // Column offsets of the 1A / 2A / 3A blocks, and the promo each maps to. A year group is a
  // position in the sheet, never a promo, so the mapping is an argument: next year's sheet has the
  // same three blocks and three different promos.
  const blocks = [
    { label: '1A', col: 0, promo: promo1A },
    { label: '2A', col: 4, promo: promo1A - 1 },
    { label: '3A', col: 8, promo: promo1A - 2 },
  ];

  const rows: unknown[][] = [];
  ws.eachRow((row) => rows.push(row.values as unknown[]));

  const out: Candidate[] = [];
  const skipped: string[] = [];
  for (const { label, col, promo } of blocks) {
    for (const raw of rows) {
      const cell = (i: number): string => {
        const v = (raw as unknown[])[i + 1];
        if (v === null || v === undefined) return '';
        if (typeof v === 'object') return String((v as { text?: string }).text ?? '').trim();
        return String(v).trim();
      };
      const lastName = cell(col);
      const firstName = cell(col + 1);
      const cotisation = cell(col + 2).toLowerCase();
      if (!lastName && !firstName) continue;
      if (lastName.toLowerCase() === 'nom' || lastName === label) continue; // header rows

      if (cotisation !== 'oui' && cotisation !== 'non') {
        skipped.push(`${label} "${lastName} ${firstName}" -> cotisation="${cotisation}"`);
        continue;
      }
      if (cotisation === 'non') continue;

      const matchKey = normalizeMatchKey(lastName, firstName, promo);
      if (!matchKey) {
        skipped.push(`${label} "${lastName} ${firstName}" -> unusable name`);
        continue;
      }
      out.push({
        matchKey,
        sourceLabel: `${lastName} ${firstName} (${label})`,
        metadata: { source: 'bde-sheet', yearGroup: label, promo },
      });
    }
  }

  if (skipped.length > 0) {
    console.log(`\n!! ${skipped.length} BDE row(s) need a human decision, NOT imported:`);
    for (const s of skipped) console.log(`   - ${s}`);
  }
  return out;
}

/** Reads Le Cercle's pre-2026 SQLite base: one `transaction` row per cotisation paid. */
function readCercle(file: string, reference: ReferenceName[]): Candidate[] {
  const db = new Database(file, { readonly: true });

  // Assert the product before trusting its id: a different legacy dump could number it otherwise,
  // and importing the wrong consommable would stage a roster of beer drinkers as cotisants.
  const product = db
    .query('SELECT nom FROM consommable WHERE id = ?')
    .get(CERCLE_COTISATION_CONSOMMABLE_ID) as { nom?: string } | null;
  if (product?.nom !== CERCLE_COTISATION_NAME) {
    throw new Error(
      `consommable ${CERCLE_COTISATION_CONSOMMABLE_ID} is "${product?.nom ?? 'missing'}", ` +
        `expected "${CERCLE_COTISATION_NAME}" - wrong database, or the ids differ`
    );
  }

  const rows = db
    .query(
      `SELECT DISTINCT u.id_user AS id, u.nom AS nom, u.prenom AS prenom, u.promo AS promo
         FROM "transaction" t
         JOIN user u ON u.id_user = t.id_user
        WHERE t.id_B_C = ? AND t.B_C_A = 'C'`
    )
    .all(CERCLE_COTISATION_CONSOMMABLE_ID) as {
    id: number;
    nom: string;
    prenom: string;
    promo: number;
  }[];

  const out: Candidate[] = [];
  const skipped: string[] = [];
  let repaired = 0;
  for (const r of rows) {
    let lastName = r.nom;
    let firstName = r.prenom;

    // Every accent in this base was destroyed before the export and replaced by `?`, so 150 of its
    // cotisants carry an unmatchable name. `normalizeMatchKey` refuses those outright; recovering
    // the real spelling from the directory is what keeps one cotisant in eight from being lost.
    if (`${lastName}${firstName}`.includes('?')) {
      const fixed =
        reference.length > 0 ? repairName(lastName, firstName, r.promo, reference) : null;
      if (!fixed) {
        skipped.push(
          `id_user=${r.id} "${r.nom} ${r.prenom}" promo=${r.promo}` +
            (reference.length === 0 ? ' (no --repair-names reference given)' : ' (no unique match)')
        );
        continue;
      }
      lastName = fixed.lastName;
      firstName = fixed.firstName;
      repaired++;
    }

    const matchKey = normalizeMatchKey(lastName, firstName, r.promo);
    if (!matchKey) {
      skipped.push(`id_user=${r.id} "${r.nom} ${r.prenom}" promo=${r.promo}`);
      continue;
    }
    out.push({
      matchKey,
      sourceLabel: `${lastName} ${firstName} (${r.promo})`,
      metadata: {
        source: 'cercle-legacy-db',
        legacyUserId: r.id,
        promo: r.promo,
        ...(lastName !== r.nom || firstName !== r.prenom
          ? { repairedFrom: `${r.nom} ${r.prenom}` }
          : {}),
      },
    });
  }
  if (repaired > 0) console.log(`\n${repaired} name(s) repaired against the reference directory.`);
  if (skipped.length > 0) {
    console.log(`\n!! ${skipped.length} Cercle cotisant(s) have no usable key, NOT imported:`);
    for (const s of skipped) console.log(`   - ${s}`);
  }
  return out;
}

async function main(): Promise<void> {
  const source = arg('source');
  const file = arg('file');
  const dryRun = process.argv.includes('--dry-run');
  const emitSql = arg('emit-sql');
  if ((source !== 'bde' && source !== 'cercle') || !file) {
    throw new Error(
      'usage: --source bde|cercle --file <path> [--promo-1a <year>] [--dry-run] [--emit-sql <path>]'
    );
  }

  const slug = source === 'bde' ? 'bde' : 'cercle';
  const variantKey = source === 'bde' ? null : CERCLE_VARIANT_KEY;
  const batch = `${source}-legacy-${new Date().toISOString().slice(0, 7)}`;

  let candidates: Candidate[];
  if (source === 'bde') {
    const promo1A = Number(arg('promo-1a'));
    if (!Number.isInteger(promo1A)) {
      throw new Error('--promo-1a is required for the BDE sheet (e.g. 2025 for the 25/26 list)');
    }
    candidates = await readBde(file, promo1A);
  } else {
    const referenceFile = arg('repair-names');
    const reference = referenceFile ? loadNameReference(referenceFile) : [];
    if (referenceFile) console.log(`reference directory: ${reference.length} people`);
    candidates = readCercle(file, reference);
  }

  // Ambiguity INSIDE the source is refused here, in front of whoever can still read the file.
  // Left to the database it would surface as an opaque constraint violation, and left to the claim
  // it could only be resolved by guessing at some member's sign-in months later.
  const byKey = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byKey.get(c.matchKey) ?? [];
    list.push(c);
    byKey.set(c.matchKey, list);
  }
  const ambiguous = [...byKey.values()].filter((l) => l.length > 1);
  if (ambiguous.length > 0) {
    console.error(`\nREFUSED: ${ambiguous.length} key(s) appear more than once in this source:`);
    for (const list of ambiguous) {
      console.error(`   ${list[0]!.matchKey} <- ${list.map((c) => c.sourceLabel).join(' | ')}`);
    }
    console.error('\nResolve them in the source and re-run. Nothing was written.');
    process.exitCode = 1;
    return;
  }

  console.log(`\n${candidates.length} cotisant(s) parsed from ${source} -> assoc "${slug}", tier ${variantKey ?? 'base'}`);

  // A dry run checks the SOURCE and stops. It deliberately does not reach the database: the
  // association and tier checks below are preconditions for writing, and pretending to run them
  // without a connection would report a pass nobody verified.
  if (dryRun) {
    console.log(`--dry-run: source is consistent. Would stage ${candidates.length} row(s) as batch "${batch}".`);
    return;
  }

  // Emitting SQL reaches the database no less than connecting does - it just does it through the
  // one door the deployed estates have. Everything above has already run, so the file carries a
  // load whose source was parsed, keyed and checked for ambiguity exactly as the connected path
  // checks it; the three preconditions that need the database travel inside the transaction.
  //
  // TO A FILE AND NOT STDOUT: this script logs its progress on stdout, and interleaving that with
  // a thousand INSERT tuples would produce a file psql refuses somewhere in the middle.
  if (emitSql) {
    writeFileSync(emitSql, renderLegacyCotisationSql({ rows: candidates, slug, variantKey, batch }));
    console.log(
      `--emit-sql: wrote ${candidates.length} row(s) as batch "${batch}" to ${emitSql}.\n` +
        'It names real people - keep it out of the repository, and apply it with ON_ERROR_STOP=1.'
    );
    return;
  }

  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE || 'auth_db',
    connectionString: process.env.DATABASE_URL,
  });
  await client.connect();
  try {
    const assoc = await client.query<{ id: string; cotisationMode: string | null }>(
      'SELECT id, "cotisationMode" FROM associations WHERE slug = $1',
      [slug]
    );
    const association = assoc.rows[0];
    if (!association) throw new Error(`no association with slug "${slug}"`);
    if (!association.cotisationMode) throw new Error(`cotisation is not enabled on "${slug}"`);

    // Fail now if the tier does not exist, rather than once per member at sign-in: `grantCotisant`
    // validates against the same catalogue and would refuse every single claim.
    const tiers = await client.query<{ variantKey: string | null }>(
      `SELECT DISTINCT "variantKey" FROM association_products
        WHERE "associationId" = $1 AND type = 'membership'`,
      [association.id]
    );
    const known = tiers.rows.map((t) => t.variantKey);
    if (!known.includes(variantKey)) {
      throw new Error(
        `"${slug}" has no ${variantKey ?? 'base'} tier (has: ${known.map((k) => k ?? 'base').join(', ')})`
      );
    }

    let inserted = 0;
    for (const c of candidates) {
      const res = await client.query(
        `INSERT INTO legacy_cotisations
           ("matchKey", "sourceLabel", "associationId", "variantKey", "sourceBatch", metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ("matchKey", "associationId") WHERE "claimedByUserId" IS NULL DO NOTHING`,
        [c.matchKey, c.sourceLabel, association.id, variantKey, batch, JSON.stringify(c.metadata)]
      );
      inserted += res.rowCount ?? 0;
    }
    console.log(
      `\nstaged ${inserted} new row(s) as batch "${batch}"; ` +
        `${candidates.length - inserted} already present (re-run, or already claimed).`
    );
  } finally {
    await client.end();
  }
}

await main();
