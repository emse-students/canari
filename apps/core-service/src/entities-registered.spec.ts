import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every entity a module asks for must be registered on the root DataSource.
 *
 * WHAT BROKE, MEASURED ON PROD ON 2026-08-28. `UsersModule` declared
 * `TypeOrmModule.forFeature([User, UserBlock])` while `app.module.ts` listed five entities and not
 * `UserBlock`. Those two lists look like the same statement and are not: `forFeature` publishes the
 * repository PROVIDER, so injection resolves and the service constructs, while the METADATA comes
 * from the root array - and without it the first query throws
 * `EntityMetadataNotFoundError: No metadata for "UserBlock" was found`. Nothing catches that
 * earlier: it compiles, the container boots, Nest maps all three `me/blocks` routes, the CD deploy
 * is green, and the failure is a 500 on the first person who opens a settings page.
 *
 * AND IT TOOK DOWN MORE THAN THE FEATURE IT BELONGED TO. Both conversation-creation paths ask
 * `isBlockedWith` BEFORE minting anything, deliberately, because the authoritative refusal lands
 * after the Welcomes have gone out. Those call sites are written to stop rather than guess - "a
 * failure to ask is not an answer" - so a 500 on the pre-check made opening a 1-to-1 return
 * silently and dropped every target of a group invitation. The design failed CLOSED, which is the
 * right direction and is also why no error reached a user: the gesture just did nothing.
 *
 * WHY THIS SHAPE OF TEST. The defect is a DISAGREEMENT BETWEEN TWO LISTS, and no compiler compares
 * them - the same class of fault as `.husky/pre-push` naming six trees and not the harness. A test
 * that only pinned `UserBlock` would pass for ever while the next entity repeated the mistake, so
 * this reads both lists out of the source and asserts the inclusion, whatever they come to hold.
 * Source parsing rather than booting the module: instantiating the DataSource needs a database, and
 * the assertion is about what the file SAYS.
 */

/** Every `.module.ts` under `src`, which is where `forFeature` can appear. */
function moduleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...moduleFiles(path));
    else if (name.endsWith('.module.ts')) out.push(path);
  }
  return out;
}

/**
 * The identifiers inside a bracketed list, given the text that introduces it.
 *
 * The closing bracket is found by counting depth rather than by the first `]`, so a nested array or
 * a generic never truncates the list and reports a missing entity as registered.
 */
function identifiersAfter(
  source: string,
  intro: string,
  from = 0
): { names: string[]; end: number } {
  const at = source.indexOf(intro, from);
  if (at === -1) return { names: [], end: -1 };
  const open = source.indexOf('[', at);
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']' && --depth === 0) {
      close = i;
      break;
    }
  }
  expect(close).toBeGreaterThan(open);
  const body = source.slice(open + 1, close);
  return {
    // Comments are stripped first: the explanation above `entities:` names `UserBlock` in prose, and
    // a parser reading that as a registration would assert the very thing it exists to check.
    names: body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => /^[A-Z][A-Za-z0-9_]*$/.test(x)),
    end: close,
  };
}

const SRC = __dirname;
const rootSource = readFileSync(join(SRC, 'app.module.ts'), 'utf8');

describe('the root DataSource registers every entity some module asks for', () => {
  const registered = identifiersAfter(rootSource, 'entities:').names;

  it('reads a non-empty entities list, or the assertion below is vacuous', () => {
    expect(registered.length).toBeGreaterThan(1);
    expect(registered).toContain('User');
  });

  it('registers each entity named in a forFeature, in every module', () => {
    const missing: string[] = [];
    for (const file of moduleFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      // A module may call `forFeature` more than once; each call is walked from the previous end.
      let from = 0;
      for (;;) {
        const { names, end } = identifiersAfter(source, 'forFeature(', from);
        if (end === -1) break;
        for (const name of names) {
          if (!registered.includes(name)) missing.push(`${name} (${file.slice(SRC.length + 1)})`);
        }
        from = end;
      }
    }
    // The message carries the file, because the fix is in `app.module.ts` and the evidence is not.
    expect(missing).toEqual([]);
  });

  it('imports every entity it registers, so the list cannot name a value that is not there', () => {
    for (const name of registered) {
      expect(rootSource).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from`));
    }
  });
});
