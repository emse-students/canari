/**
 * THE TABLES AND COLUMNS THE ENTITIES DECLARE, READ FROM THE SOURCE RATHER THAN TYPED.
 *
 * WHY A PARSER AND NOT A LIST. The dev seed (`seed.ts`) names tables and columns, and the schema it
 * lands in was built by TypeORM from these very declarations (`synchronize`; no migration file
 * creates `users` or `posts`). A column renamed in an entity and not in the seed must fail
 * `seed.test.ts` on the pull request, not the dev reset on the box - and a hand-written list of
 * columns would be one more copy of the schema, agreeing with the seed and wrong about both.
 *
 * WHAT IT UNDERSTANDS, AND IT IS DELIBERATELY NARROW. The entity files are regular: one decorator
 * stack per property, the property on its own line after it. It reads `@Entity`, the five column
 * decorators, `@JoinColumn({ name })` for the two relations that own a foreign key, and from each
 * column's options `name`, `nullable`, `default` and `insert: false`. `@VirtualColumn` is a query,
 * not a column, and is skipped. Anything it cannot read makes the derivation SMALLER, never larger,
 * and `seed.test.ts` asserts the population it found against the files on disk so a parser that
 * stopped matching is a red test rather than a quietly empty schema.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** One column as an entity declares it. */
export interface EntityColumn {
  /** The database column name: the `name:` option when present, else the property name. */
  name: string;
  /** The TypeScript property the column is mapped to. */
  property: string;
  /** True when an INSERT may leave the column out: nullable, defaulted, generated or timestamped. */
  optional: boolean;
  /** True for `insert: false` columns, which the ORM never writes and a seed must not either. */
  readOnly: boolean;
  /** The string values the property's declared type allows, when it is a closed set; else null. */
  allowed: string[] | null;
}

/** One table as an entity declares it. */
export interface EntityTable {
  table: string;
  className: string;
  /** Repository-relative path of the declaring file. */
  file: string;
  columns: Map<string, EntityColumn>;
}

const COLUMN_DECORATORS = new Set([
  'Column',
  'PrimaryColumn',
  'PrimaryGeneratedColumn',
  'CreateDateColumn',
  'UpdateDateColumn',
]);

/** TypeORM's default table name for an `@Entity()` with no argument: the class name, snake_cased. */
export function snakeCase(className: string): string {
  return className.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Every `*.entity.ts` under `apps/*\/src`, repository-relative, sorted. */
export function entityFiles(repoRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.entity.ts'))
        found.push(relative(repoRoot, path).replace(/\\/g, '/'));
    }
  };
  for (const app of readdirSync(join(repoRoot, 'apps'))) {
    const src = join(repoRoot, 'apps', app, 'src');
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      // An app with no `src` declares no entity; nothing to read, and nothing is lost by saying so.
      console.debug(`[dev-seed] apps/${app} has no src directory - no entities read there`);
    }
  }
  return found.sort();
}

/** The string literals of `export enum X { A = 'a', ... }` declared in `source`, by enum name. */
function stringEnums(source: string): Map<string, string[]> {
  const enums = new Map<string, string[]>();
  for (const m of source.matchAll(/enum\s+(\w+)\s*\{([^}]*)\}/g)) {
    const values = [...m[2].matchAll(/=\s*'([^']*)'/g)].map((v) => v[1]);
    if (values.length > 0) enums.set(m[1], values);
  }
  return enums;
}

/** `export const X = ['a', 'b'] as const` arrays declared in `source`, by constant name. */
function constArrays(source: string): Map<string, string[]> {
  const arrays = new Map<string, string[]>();
  for (const m of source.matchAll(/const\s+(\w+)\s*=\s*\[([^\]]*)\]\s*as\s+const/g)) {
    arrays.set(
      m[1],
      [...m[2].matchAll(/'([^']*)'/g)].map((v) => v[1])
    );
  }
  return arrays;
}

/**
 * The closed set of strings a property's type annotation allows, or null when it is open.
 *
 * Three shapes are recognised because the entities use exactly three: a union of literals
 * (`'association' | 'list' | 'institution'`), a string enum declared in the same file, and a type
 * alias `(typeof ARRAY)[number]` over a const array in the same file. `| null` is ignored - whether
 * NULL is allowed is the column's `nullable`, not its type.
 */
function allowedValues(
  annotation: string,
  source: string,
  enums: Map<string, string[]>,
  arrays: Map<string, string[]>
): string[] | null {
  const parts = annotation
    .split('|')
    .map((p) => p.trim())
    .filter((p) => p !== 'null' && p !== 'undefined' && p !== '');
  if (parts.length === 0) return null;
  if (parts.every((p) => /^'[^']*'$/.test(p))) return parts.map((p) => p.slice(1, -1));
  if (parts.length === 1) {
    const name = parts[0];
    if (enums.has(name)) return enums.get(name) ?? null;
    const alias = source.match(
      new RegExp(`type\\s+${name}\\s*=\\s*\\(typeof\\s+(\\w+)\\)\\[number\\]`)
    );
    if (alias && arrays.has(alias[1])) return arrays.get(alias[1]) ?? null;
  }
  return null;
}

/** Reads the `name: '...'` option out of a decorator's text, if it has one. */
function nameOption(decorator: string): string | null {
  const m = decorator.match(/\bname:\s*'([^']+)'/);
  return m ? m[1] : null;
}

/**
 * Parses one entity file. Returns null for a file that declares no `@Entity` (a few `*.entity.ts`
 * export only helpers), and throws for one whose `@Entity` argument is not a literal - that is a
 * file this parser cannot describe, and a silent skip would shrink the schema the test trusts.
 */
export function parseEntityFile(repoRoot: string, file: string): EntityTable | null {
  const source = readFileSync(join(repoRoot, file), 'utf8');
  // The class is the first one declared after `@Entity(...)`: other class decorators (`@Index`,
  // `@Unique`, some of them spanning lines) may sit between the two.
  const entity = source.match(/@Entity\(\s*(?:'([^']+)')?\s*\)[\s\S]*?export\s+class\s+(\w+)/);
  if (!entity) {
    if (/@Entity\(/.test(source)) {
      throw new Error(`${file}: @Entity found but not in a shape this parser reads`);
    }
    return null;
  }
  const className = entity[2];
  const table = entity[1] ?? snakeCase(className);
  const enums = stringEnums(source);
  const arrays = constArrays(source);

  // The class body only: the file can declare enums and helpers above it whose lines look like
  // properties (`POST_AS_ASSO = 1 << 0` does not, but an interface field would).
  const body = source.slice(source.indexOf(`class ${className}`));
  const columns = new Map<string, EntityColumn>();
  let pending: string[] = [];
  let current = '';
  let depth = 0;

  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '');
    if (depth > 0) {
      current += `\n${line}`;
      depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
      if (depth <= 0) {
        pending.push(current);
        current = '';
        depth = 0;
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    if (trimmed.startsWith('@')) {
      current = trimmed;
      depth = (trimmed.match(/\(/g) ?? []).length - (trimmed.match(/\)/g) ?? []).length;
      if (depth <= 0) {
        pending.push(current);
        current = '';
        depth = 0;
      }
      continue;
    }
    const prop = trimmed.match(/^(\w+)[?!]?\s*:\s*([^;=]+?)\s*;?$/);
    if (prop && pending.length > 0) {
      const property = prop[1];
      const annotation = prop[2];
      for (const decorator of pending) {
        const kind = decorator.match(/^@(\w+)\(/)?.[1] ?? '';
        if (COLUMN_DECORATORS.has(kind)) {
          const name = nameOption(decorator) ?? property;
          const generated =
            kind === 'PrimaryGeneratedColumn' ||
            kind === 'CreateDateColumn' ||
            kind === 'UpdateDateColumn';
          columns.set(name, {
            name,
            property,
            optional:
              generated || /\bnullable:\s*true\b/.test(decorator) || /\bdefault:/.test(decorator),
            readOnly: /\binsert:\s*false\b/.test(decorator),
            allowed: allowedValues(annotation, source, enums, arrays),
          });
        } else if (kind === 'JoinColumn') {
          // A relation that OWNS its foreign key names the column here; it is nullable unless the
          // relation says otherwise, and no seeded table carries one, so it is recorded as optional.
          const name = nameOption(decorator);
          if (name && !columns.has(name)) {
            columns.set(name, { name, property, optional: true, readOnly: false, allowed: null });
          }
        }
      }
      pending = [];
      continue;
    }
    if (trimmed !== '' && !trimmed.startsWith('@')) pending = [];
  }
  return { table, className, file, columns };
}

/** Every table the entities declare, keyed by table name. Throws on two entities claiming one table. */
export function readSchema(repoRoot: string): Map<string, EntityTable> {
  const schema = new Map<string, EntityTable>();
  for (const file of entityFiles(repoRoot)) {
    const parsed = parseEntityFile(repoRoot, file);
    if (!parsed) continue;
    const clash = schema.get(parsed.table);
    if (clash) throw new Error(`${parsed.table} is declared by both ${clash.file} and ${file}`);
    schema.set(parsed.table, parsed);
  }
  return schema;
}

/** One named CHECK constraint, and the file whose text last added it. */
export interface CheckConstraint {
  table: string;
  name: string;
  file: string;
}

/** The table a DDL statement is about: `ALTER TABLE x` or `CREATE TABLE x`, else null. */
function statementTable(statement: string): string | null {
  const m = statement.match(
    /\b(?:ALTER\s+TABLE(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+(?:public\.)?"?(\w+)"?/i
  );
  return m ? m[1] : null;
}

/**
 * EVERY NAMED CHECK THE SCHEMA CARRIES, from both places one is written: an entity's
 * `@Check('name', ...)` (what `synchronize` builds) and a migration's `CONSTRAINT name CHECK`
 * (what a deployed estate has - several checks exist ONLY there). Migrations are read in order per
 * app, so a constraint a later file drops and never re-adds is gone.
 *
 * WHY IT EXISTS: a CHECK is a row-level rule the column parser above cannot see. A seed row that
 * breaks one rolls the whole dev reset back on the box (2026-10-27: migration 114's
 * `CHK_user_follows_accepted_at` against seeded `accepted` follows that carried no `acceptedAt`).
 * `seed.test.ts` demands a predicate for every check on a seeded table, so a NEW check fails the
 * pull request that adds it until somebody states what it means for the seed.
 *
 * An UNNAMED check cannot be tracked by name, so it is reported with a synthetic `unnamed@file`
 * name - which no predicate matches, and the test then asks for the constraint to be named.
 */
export function readChecks(repoRoot: string): CheckConstraint[] {
  const found = new Map<string, CheckConstraint>();
  const key = (table: string, name: string) => `${table}.${name}`;

  for (const file of entityFiles(repoRoot)) {
    const source = readFileSync(join(repoRoot, file), 'utf8');
    const entity = source.match(/@Entity\(\s*(?:'([^']+)')?\s*\)[\s\S]*?export\s+class\s+(\w+)/);
    if (!entity) continue;
    const table = entity[1] ?? snakeCase(entity[2]);
    for (const m of source.matchAll(/@Check\(\s*'([^']+)'/g)) {
      found.set(key(table, m[1]), { table, name: m[1], file });
    }
  }

  for (const app of readdirSync(join(repoRoot, 'apps'))) {
    const dir = join(repoRoot, 'apps', app, 'src', 'migrations');
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    } catch {
      console.debug(`[dev-seed] apps/${app} has no migrations directory - no checks read there`);
      continue;
    }
    for (const name of files) {
      const file = `apps/${app}/src/migrations/${name}`;
      const sql = readFileSync(join(dir, name), 'utf8').replace(/--[^\n]*/g, '');
      for (const statement of sql.split(';')) {
        const table = statementTable(statement);
        if (!table) continue;
        for (const m of statement.matchAll(/DROP\s+CONSTRAINT(?:\s+IF\s+EXISTS)?\s+"?(\w+)"?/gi)) {
          found.delete(key(table, m[1]));
        }
        for (const m of statement.matchAll(/CONSTRAINT\s+"?(\w+)"?\s+CHECK\b/gi)) {
          found.set(key(table, m[1]), { table, name: m[1], file });
        }
        // A CHECK not preceded by `CONSTRAINT name` is unnamed.
        const named = [...statement.matchAll(/CONSTRAINT\s+"?\w+"?\s+CHECK\b/gi)].length;
        const all = [...statement.matchAll(/\bCHECK\s*\(/gi)].length;
        if (all > named) {
          const unnamed = `unnamed@${file}`;
          found.set(key(table, unnamed), { table, name: unnamed, file });
        }
      }
    }
  }
  return [...found.values()].sort((a, b) =>
    key(a.table, a.name).localeCompare(key(b.table, b.name))
  );
}

/**
 * The bit count of `AssociationPermissionFlag`, read from the enum itself so the seed's
 * all-permissions mask follows a flag added there instead of silently lacking it.
 */
export function associationPermissionBits(repoRoot: string): number {
  const file = 'apps/social-service/src/associations/entities/association-member.entity.ts';
  const source = readFileSync(join(repoRoot, file), 'utf8');
  const block = source.match(/enum\s+AssociationPermissionFlag\s*\{([^}]*)\}/);
  if (!block) throw new Error(`${file}: AssociationPermissionFlag not found`);
  const shifts = [...block[1].matchAll(/1\s*<<\s*(\d+)/g)].map((m) => Number(m[1]));
  if (shifts.length === 0) throw new Error(`${file}: AssociationPermissionFlag declares no flag`);
  return Math.max(...shifts) + 1;
}
