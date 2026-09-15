import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { withoutAnyComments } from '$lib/styles/markupSources';

/**
 * NO MEMBER-FACING SCREEN MAY RENDER THE SERVER'S OWN SENTENCE.
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

/**
 * The trees this guard owns. Others follow tree by tree; see `docs/wiki/backlog.md`.
 *
 * A tree is added only once every file under it answers, which is why they arrive in batches
 * rather than one file at a time: a guard that owns half a directory is one a new file walks past.
 *
 * The calendar trees joined on 2026-09-13 with the endpoint they needed: the global agenda's three
 * catch blocks all read `e.message`, and the one on the deposit modal is where "endsAt must be after
 * startsAt" reached a French reader. The two load failures were closed by deleting the preference -
 * the fallback each line already declared is the right answer - and the write failure by three
 * codes at the throw (`CALENDAR_ERROR_CODES`) that both modals translate through one mapper.
 */
const TREES = [
  'src/lib/components/associations',
  'src/lib/components/calendar',
  'src/lib/components/shop',
  'src/routes/associations',
  'src/routes/calendar',
  'src/routes/shop',
  'src/lib/components/posts',
  'src/lib/components/settings',
  'src/routes/posts',
  'src/routes/profile',
  'src/routes/lists',
  'src/routes/documents',
  'src/routes/forms',
  // THE FIVE ROUTE TREES A MEMBER MEETS WITHOUT BEING ANYWHERE YET, added 2026-09-15. Two invite
  // landings, the purchase history, the directory and the OIDC callback - seven sites, six of them
  // the ordinary shape where the declared fallback was already the right answer.
  //
  // The callback was the one that had to gain a message rather than lose a preference: its fallback
  // was `String(e)`, so BOTH halves of that line were untranslatable and deleting the preference
  // alone would have left the other. It is also the most exposed line of the five - it renders into
  // the sign-in card, to a reader who has not reached the application yet and has no way to retry
  // past it - and `console.error('[callback] error:', e)` keeps the real cause for diagnosis, so
  // nothing is lost by refusing to show it.
  'src/routes/c',
  'src/routes/g',
  'src/routes/account',
  'src/routes/auth',
  'src/routes/directory',
  // THE ADMIN TREE, added 2026-09-15 - 49 sites across 13 of its 14 files, and the largest single
  // pass this guard has taken. Every one of the 49 had already declared a Paraglide fallback
  // (measured: 49 of 49, none falling back to a raw literal), so the whole tree closed by deleting
  // the preference, with nothing owed at any throw.
  //
  // IT IS ALSO THE PASS THAT FOUND WHAT THE EARLIER ONES HAD BEEN COSTING. Deleting `.message`
  // deletes the only trace of the failure wherever the catch does not log, and 42 of these 49 did
  // not - a silent swallow, which CLAUDE.md forbids outright. So each of the 42 gained a
  // `Log.d('admin.<page>.<fn> failed', e)` in the same change: the member still reads the declared
  // sentence, and the cause is still recoverable. This guard cannot assert that half - it reads one
  // regex - which is exactly why the two belong in one commit rather than one of them in a backlog.
  'src/routes/admin',
];

/**
 * Files still permitted to render a server sentence, each with the reason it cannot yet be closed.
 *
 * It exists so a pass has somewhere honest to park a site it cannot finish, rather than deleting
 * this guard to get a commit through. An entry that stops offending FAILS, so nothing rots here.
 */
const ALLOWED: Record<string, string> = {
  'src/lib/components/settings/SettingsSecuritySection.svelte':
    'The PIN-change error is the one `.message` in these trees that is NOT the server talking: ' +
    '`changePinImpl` throws `new Error(m.auth_pin_change_current_incorrect())`, so the text is ' +
    'already French. Deleting the preference here would REPLACE a correct sentence with a vaguer ' +
    'one. It is a message carrying a distinction instead of a code, which is the same rule one ' +
    'step earlier, and the typed errors that close it belong to the P1 PIN-vs-corrupt-state item ' +
    '(docs/wiki/backlog.md) - written 2026-09-08, unshipped, and not to be forked here.',
};

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

/** `x instanceof Error ? x.message` - the ternary that picks the server's English. */
const SERVER_PROSE = /instanceof Error\s*\?\s*[A-Za-z_$][\w$]*\.message/;

const files = TREES.flatMap(sourcesUnder).map((p) => relative('.', p).replace(/\\/g, '/'));

describe('no member-facing tree renders a server sentence', () => {
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
    expect(files).toContain('src/lib/components/posts/PostCard.svelte');
    expect(files).toContain('src/routes/lists/[slug]/edit/+page.svelte');
    expect(files).toContain('src/routes/calendar/+page.svelte');
    expect(files).toContain('src/routes/auth/callback/+page.svelte');
    expect(files).toContain('src/routes/directory/+page.svelte');
    expect(files).toContain('src/routes/admin/moderation/+page.svelte');
  });

  it.each(files.map((f) => [f]))('%s', (file) => {
    // The SHARED stripper: the rule has to be documentable beside the code it governs, and a
    // docblock explaining why nothing may render `.message` necessarily writes `.message`.
    const offends = SERVER_PROSE.test(withoutAnyComments(readFileSync(join(ROOT, file), 'utf8')));
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
