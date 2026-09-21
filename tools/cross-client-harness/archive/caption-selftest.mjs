/**
 * EVERY PARAGLIDE KEY THE RIG NAMES MUST STILL RESOLVE THROUGH THE HELPER THAT NAMES IT.
 *
 *   bun caption-selftest.mjs
 *
 * `selector-selftest.mjs` is the sibling of this one and answers the other half: it reads the
 * literal French the rig spells (`text=...`, `[aria-label="..."]`) and asks whether the app still
 * ships that sentence. This one reads the keys the rig resolves THROUGH `fr.json` and asks whether
 * the helper it hands them to can still do anything with them. Neither catches the other's class.
 *
 * WHY IT EXISTS, AND IT IS NOT A HYPOTHETICAL. `chat_community_member_count_label` was the plain
 * string `"Membre(s)"` until #478 pluralised it on 2026-09-09 into `{count} membre` /
 * `{count} membres`. The key was not renamed and was not a typo - it simply stopped being a single
 * string, which is the one thing `caption` requires. So `openCommunityMembers` threw on its first
 * line for twelve days, taking `setMemberRole`, `removeCommunityMember` and `inviteToCommunity`'s
 * verification with it, and NOTHING said so because no row had opened that panel in between. It
 * surfaced on 2026-09-21, inside an unrelated investigation, as a sentence accusing a key that was
 * sitting right there in the file.
 *
 * A KEY'S EXISTENCE IS NOT ITS USABILITY, which is why an existence check would not have caught it
 * and why this gate calls the helpers instead of looking the keys up itself. `caption`,
 * `captionWith`, `saysMessage` and `commonTail` need exactly ONE wording; `pluralPattern` needs
 * more than one. Both refusals are the app changing shape under the rig, and both are silent until
 * something runs.
 *
 * STATIC KEYS ONLY, deliberately, and for the same reason as `selector-selftest`: a key built by a
 * template is not a claim this repository can check.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withoutAnyComments } from '../../../frontend/src/lib/styles/markupSources.ts';
import { caption, pluralPattern, wordingsOf } from '../messages.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(HERE, '..');

/**
 * The helpers that take a Paraglide key first, and what each one needs of it.
 *
 * `control` is `caption` with a `text=` in front, so it has the same requirement and is checked by
 * the same call. `commonTail` is variadic, which is why its keys are collected by a second pattern.
 */
const SINGLE_WORDING = ['caption', 'control', 'captionWith', 'saysMessage'];

/** Every `.mjs` under the harness, `archive/` included - the same walk `selector-selftest` uses. */
function harnessFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) harnessFiles(p, out);
    else if (entry.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/** `{ key, helper, where }` for every static key handed to one of the helpers above. */
function keyUsesIn(source, where) {
  const out = [];
  for (const helper of [...SINGLE_WORDING, 'pluralPattern']) {
    for (const m of source.matchAll(new RegExp(`\\b${helper}\\(\\s*'([a-z0-9_]+)'`, 'g'))) {
      out.push({ key: m[1], helper, where });
    }
  }
  // `commonTail('a', 'b', ...)`: every argument is a key and all of them need one wording.
  for (const m of source.matchAll(/\bcommonTail\(([^)]*)\)/g)) {
    for (const k of m[1].matchAll(/'([a-z0-9_]+)'/g)) {
      out.push({ key: k[1], helper: 'commonTail', where });
    }
  }
  return out;
}

const uses = [];
for (const file of harnessFiles(HARNESS)) {
  // THIS FILE'S OWN DOCBLOCK NAMES THE KEY THAT BROKE, exactly as `selector-selftest`'s does, so
  // the comments come out before the scan or the gate fails on its own explanation of itself.
  uses.push(...keyUsesIn(withoutAnyComments(readFileSync(file, 'utf8')), relative(HARNESS, file)));
}

const broken = [];
for (const use of uses) {
  try {
    if (use.helper === 'pluralPattern') pluralPattern(use.key);
    else if (use.helper === 'caption' || use.helper === 'control') caption(use.key);
    // The other three interpolate or slice, and all three need exactly one wording. Asking for the
    // wordings is the whole of that requirement; what they then do with the string is their own
    // business and not something a static gate can rehearse.
    else if (wordingsOf(use.key, use.helper).length > 1) {
      throw new Error(`${use.helper}: '${use.key}' is a PLURAL - use pluralPattern('${use.key}')`);
    }
  } catch (e) {
    broken.push(`${use.where}: ${e.message}`);
  }
}

if (uses.length === 0) {
  // AN EMPTY GATE PASSES AND PROVES NOTHING, which is how `gate-selftest` was written to think. If
  // the helpers are ever renamed, this is the line that says so instead of a silent green.
  console.error('caption-selftest: FOUND NO KEYS AT ALL - the helper names above have moved');
  process.exit(1);
}

if (broken.length > 0) {
  console.error(`caption-selftest: ${broken.length} unusable key(s)`);
  for (const line of [...new Set(broken)].sort()) console.error(`  ${line}`);
  process.exit(1);
}

console.log(`caption-selftest OK - ${uses.length} key uses, all still resolvable`);
