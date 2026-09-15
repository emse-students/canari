/**
 * EVERY UI STRING THE RIG CLICKS MUST STILL EXIST IN THE APP.
 *
 *   bun selector-selftest.mjs
 *
 * `closeOverlays` closed the group settings panel by clicking `text=Fermer les paramètres du
 * groupe`. #455 unified four side panels into one `ConversationSidePanel`, whose close control is
 * `aria-label="Fermer"` - and that sentence has existed nowhere in the app since. The rig went on
 * clicking a phantom for every run in between.
 *
 * NOTHING SAID SO, AND THAT IS THE POINT. The click is `realClick(...).catch(() => {})`, because an
 * overlay that is already gone must not fail a teardown; so a selector that can NEVER match is
 * indistinguishable from one that had nothing to do. It surfaces four retries later as
 * `could not close the overlay, still on group-panel` - a sentence about the app, for a fact about
 * this repository, at the cost of whatever check was mid-flight.
 *
 * A RUN CANNOT CATCH THIS AND A STATIC READ CAN. The app's French lives in `frontend/messages`, the
 * rig's French lives in its own sources, and the two are edited in different pull requests months
 * apart. Comparing them needs no browser, no device and no estate, which is why this is in the CI
 * gate rather than in `test-harness-device`.
 *
 * WHAT IT DOES NOT CHECK, DELIBERATELY. A selector built by a template (`text=${name}`) is not a
 * claim about the app - the rig is spelling a group it just created. Only STATIC literals are read,
 * so this gate is silent about the dynamic ones rather than guessing at them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// THE REPOSITORY'S ONE COMMENT STRIPPER, and not a fourth private copy - three high CodeQL alerts
// is what the previous three cost. It matters here because this file's own docblock names the
// phantom selector above: read raw, the gate would fail on its own explanation of itself.
import { withoutAnyComments } from '../../../frontend/src/lib/styles/markupSources.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(HERE, '..');
const MESSAGES = join(HERE, '../../../frontend/messages/fr.json');

/**
 * Strings the rig spells that are NOT app UI, each with the reason it is not.
 *
 * SELF-INVALIDATING: an entry that DOES turn out to exist in `fr.json` fails this gate, because a
 * forgiveness that has quietly become unnecessary is how the next real miss gets forgiven too.
 */
const NOT_APP_UI = {
  ParlerMarteau: 'a fixture name this campaign types into a PDF, not a control',
  general: 'a channel slug the rig creates, not a label the app ships',
};

/** Every `.mjs` under the harness, including `archive/`, which is where most runners live. */
function harnessFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) harnessFiles(p, out);
    else if (entry.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/**
 * Every STATIC string literal in `source`, as its raw text.
 *
 * Quote-aware rather than regex, for the reason `withoutAnyComments` walks rather than matches: a
 * literal ends at ITS OWN quote character, so `'text=Envoyer l\'invitation'` is one string and not
 * a string that stops at the apostrophe. A regex over `[^'"]` reported `Envoyer l` and would have
 * demanded the app ship that.
 */
function stringLiterals(source) {
  const out = [];
  for (let i = 0; i < source.length; i += 1) {
    const q = source[i];
    if (q !== '"' && q !== "'" && q !== '`') continue;
    let body = '';
    let interpolated = false;
    let j = i + 1;
    for (; j < source.length; j += 1) {
      const c = source[j];
      if (c === '\\') {
        body += source[j + 1] ?? '';
        j += 1;
      } else if (c === q) break;
      else if (c === '\n' && q !== '`') {
        // An unterminated single-quoted literal is not a literal; give up on it rather than
        // swallowing the rest of the file as one enormous string.
        body = null;
        break;
      } else {
        if (c === '$' && source[j + 1] === '{') interpolated = true;
        body += c;
      }
    }
    if (body !== null && !interpolated) out.push(body);
    i = j;
  }
  return out;
}

/** The UI strings one literal claims the app shows: a `text=` selector, or any `aria-label` in it. */
function uiStringsIn(literal) {
  const out = [];
  if (literal.startsWith('text=')) out.push(literal.slice(5));
  for (const m of literal.matchAll(/\[aria-label="([^"]+)"\]/g)) out.push(m[1]);
  // A selector is a claim about a LABEL, so an empty one claims nothing, and a bare punctuation
  // string is a CSS artefact rather than French.
  return out.filter((s) => /[a-zA-Zàâçéèêëîïôûùüÿñæœ]/.test(s));
}

const messages = Object.values(JSON.parse(readFileSync(MESSAGES, 'utf8'))).filter(
  (v) => typeof v === 'string'
);

/**
 * A message value as a pattern, so `Retirer {name}` recognises `Retirer Canari Test Beta`.
 *
 * A VALUE THAT IS NOTHING BUT PARAMETERS IS NOT EVIDENCE AND IS DROPPED. `minesweeper_time` is
 * `"{time}"`, which compiles to a pattern matching every string there is - with it in, this gate
 * reported 43 selectors checked and 0 missing, forgiving the very defect it was written for.
 */
const anchored = messages.filter((v) => v.split(/\{[^}]*\}/).some((s) => s.trim() !== ''));
const patterns = anchored.map(
  (v) =>
    new RegExp(
      `^${v
        .split(/\{[^}]*\}/)
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[\\s\\S]*')}$`
    )
);
const shippedByTheApp = (s) => messages.includes(s) || patterns.some((r) => r.test(s));

const clicked = new Map();
for (const file of harnessFiles(HARNESS)) {
  const where = relative(HARNESS, file).replace(/\\/g, '/');
  if (where === 'archive/selector-selftest.mjs') continue;
  for (const literal of stringLiterals(withoutAnyComments(readFileSync(file, 'utf8')))) {
    for (const s of uiStringsIn(literal)) {
      if (!clicked.has(s)) clicked.set(s, new Set());
      clicked.get(s).add(where);
    }
  }
}

let failures = 0;
const missing = [...clicked.entries()].filter(
  ([s]) => !shippedByTheApp(s) && !Object.hasOwn(NOT_APP_UI, s)
);
for (const [s, where] of missing.sort()) {
  failures += 1;
  console.log(`FAIL ${JSON.stringify(s)} is clicked by ${[...where].sort().join(', ')}`);
  console.log(`       but no message in frontend/messages/fr.json says it, so it can never match.`);
}

for (const [s, why] of Object.entries(NOT_APP_UI)) {
  if (!clicked.has(s)) {
    failures += 1;
    console.log(`FAIL ${JSON.stringify(s)} is allowed here (${why}) but nothing clicks it any more`);
    console.log(`       - delete the entry rather than leaving a forgiveness nobody needs.`);
  } else if (shippedByTheApp(s)) {
    failures += 1;
    console.log(`FAIL ${JSON.stringify(s)} is allowed here (${why}) but the app DOES ship it now`);
    console.log(`       - delete the entry, so a later disappearance is caught.`);
  }
}

const checked = clicked.size - Object.keys(NOT_APP_UI).length;
if (failures === 0) {
  console.log(
    `[selector] clean - ${checked} UI string(s) the rig clicks all still exist in the app, ` +
      `${Object.keys(NOT_APP_UI).length} allowed as fixtures`
  );
} else {
  console.log(`\n${failures} failure(s)`);
}

// A GATE THAT FINDS NOTHING BECAUSE IT READ NOTHING IS THE FAILURE THIS CANNOT REPORT OTHERWISE.
// A renamed directory, a changed extension or a broken walk would each leave `clicked` empty and
// every assertion above vacuously true.
if (clicked.size < 20) {
  console.log(`FAIL only ${clicked.size} selector(s) found - the scan did not read the harness`);
  process.exit(1);
}

process.exit(failures === 0 ? 0 : 1);
