import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ONE SHAPE CROSSING THE WIRE, DECLARED TWICE - AND NOTHING ELSE IN THIS REPOSITORY COULD SEE IT.
 *
 * Two shapes are written out in two languages of the same monorepo. The rest of each file
 * legitimately differs - one side PRODUCES the document and the other CONSUMES it - so a file
 * identity gate would be wrong, and `declared-duplicates.test.mjs` correctly leaves them alone.
 * What is duplicated is the shape itself:
 *
 * | the shape | producer | consumer |
 * | --- | --- | --- |
 * | the published carte | `frontend/src/lib/carte/publish.ts` | `apps/social-service/.../published-carte.ts` |
 * | the backend storage report | `apps/chat-delivery-service/.../admin-storage.controller.ts` | `frontend/src/lib/utils/backendStorage.ts` |
 *
 * **THE TWO SIDES ARE COMPILED SEPARATELY, so a field that disagrees is a runtime failure no
 * compiler here can see.** A key added on one side and forgotten on the other type-checks in both
 * projects and produces `undefined` in a browser.
 *
 * WHY THIS AND NOT A `.proto`. `libs/proto/canari.proto` is the repository's answer for a wire
 * contract with generated bindings, and it stays the answer for the MLS frames: those are bytes,
 * versioned, and read by three languages. These two are presentational TypeScript interfaces read
 * by two TypeScript trees, where a generator would cost a build step and a checked-in artefact to
 * buy what parsing the declarations already proves. **And NOT a shared TypeScript package**: that
 * was tried (`libs/shared-ts`), imported by nothing, and deleted on 2026-08-27; the reasoning is in
 * any copy of `cors-origins.ts` and it has not changed.
 *
 * The shape of this gate is `channelPushFields.test.ts`, which pins one JSON payload across a
 * TypeScript writer and three native readers for the same reason and in the same way.
 */
const here = dirname(fileURLToPath(import.meta.url));

const CARTE_FRONTEND = resolve(here, '../carte/publish.ts');
const CARTE_BACKEND = resolve(
  here,
  '../../../../apps/social-service/src/associations/published-carte.ts'
);
const STORAGE_FRONTEND = resolve(here, '../utils/backendStorage.ts');
const STORAGE_BACKEND = resolve(
  here,
  '../../../../apps/chat-delivery-service/src/controllers/admin-storage.controller.ts'
);

/**
 * The property NAMES declared by one `export interface <name>`, in source order.
 *
 * Names only, deliberately: the two sides spell the same type differently in places that cost
 * nothing (`string | null` against `string | undefined` on an optional the consumer never writes),
 * and a gate that failed on those would be turned off within a month. A field present on one side
 * and absent on the other is the failure this exists for, and no honest divergence produces it.
 */
function interfaceFields(source: string, name: string): string[] {
  const start = source.search(new RegExp(`^export interface ${name} \\{$`, 'm'));
  if (start < 0) throw new Error(`interface not found: ${name}`);
  const body = source.slice(start);
  const end = body.search(/^\}$/m);
  if (end < 0) throw new Error(`interface has no closing brace: ${name}`);
  // A property line is `  name: ...` or `  name?: ...` at ONE level of indentation, which skips
  // the nested object literals (`background: { dataUrl: ...; scrimOpacity: ... }`) whose own keys
  // are part of the parent field's type rather than fields of this interface.
  return [...body.slice(0, end).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
}

/** Both declarations of one interface, so a failure prints the two lists side by side. */
function bothSides(a: string, b: string, name: string): { name: string; a: string[]; b: string[] } {
  return { name, a: interfaceFields(a, name), b: interfaceFields(b, name) };
}

describe('the published carte is one shape, declared in the editor and in the publisher', () => {
  const frontend = readFileSync(CARTE_FRONTEND, 'utf8');
  const backend = readFileSync(CARTE_BACKEND, 'utf8');

  // Spelled out rather than discovered, so that DELETING an interface from one side fails here
  // instead of quietly shrinking the set this loop walks.
  const SHARED = [
    'PublishedCarteStage',
    'PublishedCarteStyle',
    'PublishedCarteText',
    'PublishedCarteCard',
    'PublishedCarteUnit',
    'PublishedCarteDirectoryAsso',
    'PublishedCarteDirectoryZone',
    'PublishedCarteDirectory',
    'PublishedCarte',
  ];

  /**
   * The ONE field the two sides are asymmetric about, and the asymmetry is the point.
   *
   * `version` is stamped by `sanitizePublishedCarte` and never read off the payload, so the editor
   * has nothing to declare: a client that claimed `version: 1` would be publishing a document in a
   * schema whose geometry it is not producing, and the server would have believed it. The next
   * assertion re-reads the sanitizer, so if the stamp ever becomes a read this exemption fails
   * before a forged version does.
   */
  const SERVER_STAMPED = ['version'];

  it.each(SHARED)('%s declares the same fields on both sides', (name) => {
    const { a, b } = bothSides(frontend, backend, name);
    expect({ name, editor: a }).toEqual({
      name,
      editor: b.filter((field) => !SERVER_STAMPED.includes(field)),
    });
  });

  it('extracted real fields, so nothing above can pass by being empty', () => {
    for (const name of SHARED) {
      expect({ name, fields: interfaceFields(frontend, name).length }).not.toEqual({
        name,
        fields: 0,
      });
    }
  });

  it('the version is STAMPED by the publisher, never taken from the payload', () => {
    // A poster read as v1 renders fractions of a frame as pixels, so the number is not the client's
    // to state. It is declared once, written into every sanitized document, and the sanitizer
    // reads no `version` off its input at all - which is what makes the exemption above safe.
    expect(backend).toContain('export const PUBLISHED_CARTE_VERSION = 2;');
    expect(backend).toContain('version: PUBLISHED_CARTE_VERSION,');
    expect(backend).not.toMatch(/\br\.version\b/);
    // And the editor declares none, so nothing there can drift into sending one.
    expect(interfaceFields(frontend, 'PublishedCarte')).not.toContain('version');
  });
});

describe('the backend storage report is one shape, declared in the controller and in the admin page', () => {
  const frontend = readFileSync(STORAGE_FRONTEND, 'utf8');
  const backend = readFileSync(STORAGE_BACKEND, 'utf8');

  const SHARED = [
    'MediaBucketUsage',
    'MlsTableUsage',
    'MlsQueueUsage',
    'MlsGhostUsage',
    'RedisKeyspaceUsage',
    'MlsUsage',
    'BackendStorageUsage',
  ];

  it.each(SHARED)('%s declares the same fields on both sides', (name) => {
    const { a, b } = bothSides(frontend, backend, name);
    expect({ name, page: a }).toEqual({ name, page: b });
  });

  it('extracted real fields, so nothing above can pass by being empty', () => {
    for (const name of SHARED) {
      expect({ name, fields: interfaceFields(frontend, name).length }).not.toEqual({
        name,
        fields: 0,
      });
    }
  });
});
