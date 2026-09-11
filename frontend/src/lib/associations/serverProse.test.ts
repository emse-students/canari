import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * NO SCREEN IN THE SHOP OR ASSOCIATIONS TREES MAY RENDER THE SERVER'S OWN SENTENCE.
 *
 * `socialApiError.test.ts` holds this for ONE component, because that component is where a student
 * met it: *"En passant, 'No codes left for this partnership' est non traduite."* The census that
 * followed found the same shape everywhere - `e instanceof Error ? e.message : <fallback>` - and
 * `request()` throws with the server's text, so the ternary chooses English almost every time and
 * the localized half of the line is dead code that only runs for a non-`Error` throw.
 *
 * THE BACKLOG EXPECTED THIS GUARD TO WAIT FOR THE CODES, AND IT DOES NOT HAVE TO. Distinguishing
 * one refusal from another needs a code at the THROW, per endpoint, and that is still owed. But
 * NOT SHOWING ENGLISH needs nothing from the server: the fallback each site already declared is
 * the right answer, and where the fallback was itself a raw literal ('Error', 'Erreur', 'Upload
 * error') it was two violations in one line. Seventy sites were closed on 2026-09-11 by deleting
 * the preference, and this is what stops the seventy-first.
 *
 * `ALLOWED` is the shrinking half of the contract. It is EMPTY, and an entry that stops being
 * needed fails too - a guard whose allowlist can rot is a guard that quietly stops guarding.
 */

const ROOT = process.cwd();

/** The trees this guard owns. Others follow endpoint by endpoint; see `docs/wiki/backlog.md`. */
const TREES = [
  'src/lib/components/associations',
  'src/lib/components/shop',
  'src/routes/associations',
  'src/routes/shop',
];

/**
 * Files still permitted to render a server sentence, each with the reason it cannot yet be closed.
 *
 * Deliberately empty. It exists so the next endpoint-by-endpoint pass has somewhere honest to park
 * a site it cannot finish, rather than deleting this guard to get a commit through.
 */
const ALLOWED: Record<string, string> = {};

/** Every `.svelte` and `.ts` file under `dir`, recursively. */
function sourcesUnder(dir: string): string[] {
  const abs = join(ROOT, dir);
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const full = join(abs, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourcesUnder(join(dir, name)));
    } else if (name.endsWith('.svelte') || name.endsWith('.ts')) {
      out.push(join(dir, name));
    }
  }
  return out;
}

/**
 * The file with its prose removed.
 *
 * The rule has to be documentable beside the code it governs: a docblock that explains why nothing
 * may render `.message` necessarily writes `.message`, and the first version of the single-file
 * guard failed on exactly that.
 */
function codeOnly(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** `x instanceof Error ? x.message` - the ternary that picks the server's English. */
const SERVER_PROSE = /instanceof Error\s*\?\s*[A-Za-z_$][\w$]*\.message/;

const files = TREES.flatMap(sourcesUnder).map((p) => relative('.', p).replace(/\\/g, '/'));

describe('the shop and associations trees never render a server sentence', () => {
  it('is looking at the trees it thinks it is', () => {
    // A path typo would make every assertion below vacuously true, which is the failure mode of
    // every source-level guard - and a FLOOR on the total would not catch it, because three
    // healthy trees clear any floor the fourth one's absence leaves. So each tree answers for
    // itself, and the two components the sweep actually rewrote are named.
    for (const tree of TREES) {
      expect(files.filter((f) => f.startsWith(tree)).length).toBeGreaterThan(0);
    }
    expect(files).toContain('src/lib/components/associations/edit/EditCotisationsTab.svelte');
    expect(files).toContain('src/routes/shop/+page.svelte');
  });

  it.each(files.map((f) => [f]))('%s', (file) => {
    const offends = SERVER_PROSE.test(codeOnly(readFileSync(join(ROOT, file), 'utf8')));
    if (ALLOWED[file]) {
      // An allowlisted file must STILL offend, or the entry is stale and buys nothing.
      expect(offends).toBe(true);
      expect(ALLOWED[file].length).toBeGreaterThan(20);
      return;
    }
    expect(offends).toBe(false);
  });

  it('allowlists nothing that is not in the tree', () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(files).toContain(file);
    }
  });
});
