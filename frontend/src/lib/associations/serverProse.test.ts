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
 * `ALLOWED` is the shrinking half of the contract. It holds ONE entry, and an entry that stops
 * being needed fails too - a guard whose allowlist can rot is a guard that quietly stops guarding.
 *
 * **IT OWNS `src` WHOLE SINCE 2026-09-16, AND THAT IS THE END OF THE SWEEP RATHER THAN A WIDENING
 * OF IT.** The trees arrived in batches - a guard owning half a directory is one a new file walks
 * past - and the last of them closed in the commit that wrote this line: 194 occurrences at the
 * start, ONE left, and it is the allowlisted one. Seventeen entries and their per-pass reasoning
 * collapse into this single one because there is nothing left for a partial list to mean. The
 * story of each pass, its counts and what it could not close is in `docs/wiki/backlog.md`.
 */

const ROOT = process.cwd();

/**
 * The one tree, and the only files under it this walk skips.
 *
 * A skip is permitted for exactly one reason: the file is GENERATED, not written. `src/lib/paraglide`
 * is the Paraglide compiler's output (2 658 files, so it is also the only entry that matters to the
 * clock), `src/lib/wasm` is `wasm-pack`'s, and `src/lib/proto/canari.{js,d.ts}` is protobufjs's -
 * none of the three is in git, and every pipeline rebuilds them with `bun run generate`. A
 * hand-written file that cannot answer does NOT come here: it goes in `ALLOWED` with its reason,
 * where it fails the day it stops offending.
 */
const TREES = ['src'];

const GENERATED = [
  'src/lib/paraglide',
  'src/lib/wasm',
  'src/lib/proto/canari.js',
  'src/lib/proto/canari.d.ts',
];

/**
 * The trees this guard entered one at a time, kept as the typo guard the per-tree assertion used to
 * be. A single `TREES` entry makes one kind of mistake invisible - a walk that silently returns a
 * fraction of `src` still clears any floor on the total - so each of these still answers for itself.
 */
const MUST_COVER = [
  'src/routes/associations',
  'src/routes/calendar',
  'src/routes/shop',
  'src/routes/posts',
  'src/routes/profile',
  'src/routes/lists',
  'src/routes/documents',
  'src/routes/forms',
  'src/routes/c',
  'src/routes/g',
  'src/routes/account',
  'src/routes/auth',
  'src/routes/directory',
  'src/routes/admin',
  'src/lib/components',
  'src/lib/composables',
  'src/lib/utils',
  // The last trees, 2026-09-16: 29 sites, every one of them a log line or a string crossing a
  // `postMessage` boundary whose protocol declares it a string. `CallService` alone held twelve.
  'src/lib/services',
  'src/lib/mls-client',
  'src/lib/workers',
  'src/lib/stores',
  'src/lib/calendar',
];

/**
 * Files still permitted to render a server sentence, each with the reason it cannot yet be closed.
 *
 * It exists so a pass has somewhere honest to park a site it cannot finish, rather than deleting
 * this guard to get a commit through. An entry that stops offending FAILS, so nothing rots here.
 *
 * It held `SettingsSecuritySection.svelte` from 2026-09-15 to 2026-09-16: `changePinImpl` throws
 * its refusals as French sentences, so deleting the preference there would have replaced a precise
 * line with a vaguer one. `LocalizedError` closed it - the throw now says that its message is the
 * reader's, and the screen asks rather than assumes.
 *
 * `sessionAuth.ts` took its place on 2026-09-16, and it is parked DELIBERATELY rather than left
 * behind: the site compares `reason.message` against `MLS_LOCAL_STATE_UNDECRYPTABLE`, a shared
 * constant rather than a sentence, and the defect is upstream of the comparison.
 * `classifyStateLoadFailure` already separates `sealed` (an old PIN opens it) from `unknown`
 * (corruption, no PIN helps) and BOTH throws collapse the two into that one marker. Typing the
 * marker without deciding what the screen does with `unknown` would ship the same wrong diagnosis
 * behind a better shape, so it closes with the P1 that owns that question - see
 * `docs/wiki/backlog.md`. Every OTHER site in that file was closed in the same pass.
 */
const ALLOWED: Record<string, string> = {
  'src/lib/composables/session/sessionAuth.ts':
    'Compares the MLS init failure against the shared MLS_LOCAL_STATE_UNDECRYPTABLE constant. ' +
    'The marker collapses `sealed` and `unknown`, so typing it without deciding what the screen ' +
    'does with `unknown` would ship the same wrong diagnosis behind a better shape. It closes ' +
    'with the PIN-vs-corrupt-state P1 in docs/wiki/backlog.md.',
};

/** Every hand-written `.svelte` and `.ts` file under `dir`, recursively. */
function sourcesUnder(dir: string): string[] {
  const abs = join(ROOT, dir);
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const here = join(dir, name).replace(/\\/g, '/');
    if (GENERATED.includes(here)) continue;
    const full = join(abs, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourcesUnder(here));
    } else if (name.endsWith('.svelte') || name.endsWith('.ts')) {
      out.push(here);
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
    // every source-level guard - and a FLOOR on the total would not catch it, because the healthy
    // part of a walk clears any floor a missing subtree leaves. So each tree answers for itself,
    // and the components the sweep actually rewrote are named.
    for (const tree of MUST_COVER) {
      expect(files.filter((f) => f.startsWith(`${tree}/`)).length).toBeGreaterThan(0);
    }
    // The floor is the OTHER half: `MUST_COVER` cannot notice a tree nobody thought to list, and
    // `src` grows. It is deliberately far below the real count (1 004 on 2026-09-16) so it fails
    // on a broken walk rather than on a refactor.
    expect(files.length).toBeGreaterThan(800);
    // Generated output is skipped and must STAY skipped - `src/lib/paraglide` alone is 2 658 files.
    expect(files.filter((f) => GENERATED.some((g) => f.startsWith(`${g}/`) || f === g))).toEqual(
      []
    );
    expect(files).toContain('src/lib/components/associations/edit/EditCotisationsTab.svelte');
    expect(files).toContain('src/routes/shop/+page.svelte');
    expect(files).toContain('src/lib/components/posts/PostCard.svelte');
    expect(files).toContain('src/routes/lists/[slug]/edit/+page.svelte');
    expect(files).toContain('src/routes/calendar/+page.svelte');
    expect(files).toContain('src/routes/auth/callback/+page.svelte');
    expect(files).toContain('src/routes/directory/+page.svelte');
    expect(files).toContain('src/routes/admin/moderation/+page.svelte');
    expect(files).toContain('src/lib/components/sidebar/SidebarCommunityAdminModal.svelte');
    expect(files).toContain('src/lib/composables/useMessaging.svelte.ts');
    expect(files).toContain('src/lib/composables/session/sessionAuth.ts');
    expect(files).toContain('src/lib/utils/chat/groupCreation.ts');
    expect(files).toContain('src/lib/utils/graine/repair.ts');
    expect(files).toContain('src/lib/services/CallService.ts');
    expect(files).toContain('src/lib/workers/encryption.worker.ts');
    expect(files).toContain('src/hooks.client.ts');
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
