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
  // The five `lib/components` subtrees that used to be listed here - associations, calendar, shop,
  // posts, settings - are gone, not dropped: `src/lib/components` at the bottom now owns all 218
  // files, and naming a subtree under it would walk the same file twice.
  'src/routes/associations',
  'src/routes/calendar',
  'src/routes/shop',
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
  // THE WHOLE COMPONENT DIRECTORY, 218 files, taken on 2026-09-16 - and it is entered at the ROOT
  // rather than as eleven subtrees, which is the change. Five of those subtrees arrived with the
  // association, calendar, shop, posts and settings passes; six more joined on 2026-09-15 (twenty
  // sites, two of them the double violation the earlier passes named: a raw French literal as the
  // fallback, untranslated in BOTH halves of the line). What kept the root out was the OTHER shape:
  // a Paraglide key that TAKES the raw text as a parameter - `chat_send_error({ reason })`,
  // `chat_call_error({ msg })`, `auth_login_failed({ reason })` - which deleting a preference
  // cannot close, because the sentence is BUILT to carry the server's words.
  //
  // The ten that were left closed in three different ways, and the reading had to be per site:
  //
  //  - Four had a STATUS at the throw that was being spelt into a string. `calls/initiate` now
  //    throws `CallInitiateError(status, ...)`, so the toast that used to choose between two
  //    sentences with `msg.includes('Groupe introuvable')` reads the status instead; the two poll
  //    refusals go through `describeApiRefusal` like every other channel write.
  //  - Three had nothing to say beyond "it failed": an outbox rejection, a voice note that never
  //    reached the queue, an OIDC start that failed before any response existed. Each took the
  //    generic line it already had a key for, and the exception went to the log.
  //  - Three rendered a message the app itself THREW, already in French - the case this guard's
  //    allowlist existed for. They now read `localizedMessage(e, <declared line>)`, and the twelve
  //    throws behind them are `LocalizedError`. That is the same rule one step earlier: what the
  //    type says is not what went wrong, but that the message is FOR THE READER.
  //
  // ALLOWED IS THEREFORE EMPTY AGAIN, which is what it is supposed to be.
  'src/lib/components',
  // THE COMPOSABLES, 2026-09-16 - twenty-five sites, and only six of them were ever on a screen.
  //
  // THE COUNT IS THE LESSON. The backlog said three sites remained here, which was the count of
  // sites a READER meets; the regex finds the SHAPE, so nineteen log lines counted too. They are
  // not false positives and they were not exempted: a log that writes `e.message` throws away the
  // type, the stack and the `cause` of whatever it caught, so `String(e)` is simply the better
  // line - and a convention with no exceptions is the only one a regex can hold.
  //
  // The six that reached a member:
  //
  //  - A media send read the exception's sentence into a French one. Both branches of that loop
  //    share the catch and only one asks a server anything, so the status is READ
  //    (`MediaUploadError`, new) rather than assumed - which is also how a 413 stopped being
  //    indistinguishable, to the code, from a 500.
  //  - Two forwards did the same, while the function they wrap RETURNS its refusal already
  //    localized: anything reaching those catches is unexpected and says only "it failed".
  //  - The login error field showed `_e.message`, so `SessionExpiredError`'s "Session expired -
  //    please log in again" was what a French member read. `LoginFailure` is a `LocalizedError`
  //    now, and the field asks instead of assuming.
  //  - Two raw English literals were sitting beside them - 'Please fill in all fields.' and
  //    'Biometric authentication failed. Please enter your PIN manually.' - both with a Paraglide
  //    key that already existed.
  //
  // And one more that this guard cannot see: `classifyApiError` fed an arbitrary error's message
  // into `channel_action_error_generic({ detail })`, so a `TypeError` of ours was shown to a member
  // as the reason their community would not load. A detail is now quoted only when it came from a
  // documented envelope.
  'src/lib/composables',
  // THE UTILITIES, 2026-09-16 - 319 files, fifty-six sites, and NOT ONE of them was on a screen.
  //
  // That is the point of taking the tree rather than the sites a reader meets. Every one of the
  // fifty-five log lines threw away the type, the stack and the `cause` of what it caught in order
  // to print a sentence; `String(e)` prints `Error: <message>` and keeps them. A tree where the
  // shape survives only in logs is a tree where the next screen written under it copies the shape.
  //
  // THE FIFTY-SIXTH IS WHY THE COUNT OF READER-FACING SITES IS NOT THE MEASURE. `groupCreation.ts`
  // held `toUiDiscussionError`, documented as "user-friendly strings suitable for display in the
  // UI": five `raw.toLowerCase().includes(...)` branches over the words of an exception - 'no
  // registered device', 'session expir', '401', 'failed to fetch', 'already_member' - each
  // returning an English sentence, and falling back to the server's own text. Its three call sites
  // are `log(...)`, all of them, and `appendLog` writes to the console. So the mapper rendered
  // nothing, translated nothing, and depended for its correctness on prose from a layer that never
  // promised it. It is deleted; the exception goes to the log, which is where it was already going.
  //
  // With it went the LAST place in `src/lib` and `src/routes` that read an exception's words to
  // decide what had happened. What remains compares against a shared CONSTANT
  // (`MLS_LOCAL_STATE_UNDECRYPTABLE`, `MEDIA_PURGED_MESSAGE`), which is a marker, not a sentence.
  'src/lib/utils',
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
    expect(files).toContain('src/lib/components/sidebar/SidebarCommunityAdminModal.svelte');
    expect(files).toContain('src/lib/composables/useMessaging.svelte.ts');
    expect(files).toContain('src/lib/composables/session/sessionAuth.ts');
    expect(files).toContain('src/lib/utils/chat/groupCreation.ts');
    expect(files).toContain('src/lib/utils/graine/repair.ts');
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
