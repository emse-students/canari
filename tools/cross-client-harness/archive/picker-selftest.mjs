/**
 * THE RIG CHOOSES AN OPTION OF THE IN-APP PICKER BY ITS DRAWN LABEL, AND REFUSES WITH A REASON.
 *
 *   bun picker-selftest.mjs
 *
 * `chooseOption` looked for a native `<select>` until #1227 replaced every one with `Picker.svelte`,
 * whose option buttons carry no value attribute: `venue.mjs` failed `no-select` and every gesture that
 * sets a role went with it. The page-side snippets of `picker.mjs` are plain strings so they can be
 * run HERE, unchanged, against fixture markup - which is what makes this more than a test of the
 * decision function: the snippet that reads the live page is the snippet under test.
 *
 * THE FIXTURES ARE THE PICKER'S OWN MARKUP, copied from `Picker.svelte`'s template, and the labels in
 * them are READ FROM `fr.json` through `caption`, never spelt: this file would otherwise be the
 * second place a reworded role has to be changed.
 *
 * A micro DOM (below) stands in for a browser because a fresh CI checkout has no frontend
 * dependencies, so no DOM library. It implements only what the snippets use - `querySelectorAll`
 * for the two selectors they spell, `getAttribute`, `setAttribute`, `removeAttribute`, `disabled`,
 * `innerText` - and a snippet that grows past that fails here, loudly, instead of passing on a stub.
 */
import {
  currentLabelOf,
  decidePickerChoice,
  markOptionJs,
  OPTION_MARK,
  PICKER_IS_OPEN,
  PICKER_OPTIONS_JS,
  triggerByLabel,
  UNMARK_OPTION_JS,
} from '../picker.mjs';
import { caption } from '../messages.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

/** Parses fixture markup into flat elements with `parent` links; text nodes become `texts`. */
function parse(html) {
  const root = { tag: '#root', attrs: {}, parent: null, texts: [], children: [] };
  const all = [];
  let cur = root;
  const token = /<(\/)?([a-z0-9]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>|([^<]+)/gi;
  for (const m of html.matchAll(token)) {
    if (m[4] !== undefined) {
      if (m[4].trim()) cur.texts.push(m[4].trim());
    } else if (m[1]) {
      cur = cur.parent ?? root;
    } else {
      const attrs = {};
      for (const a of m[3].matchAll(/([a-z-]+)(?:="([^"]*)")?/gi)) attrs[a[1]] = a[2] ?? '';
      const el = { tag: m[2], attrs, parent: cur, texts: [], children: [] };
      cur.children.push(el);
      all.push(el);
      cur = el;
    }
  }
  return all;
}

/** A `document` over fixture markup, shaped like the page-side API the snippets call. */
function documentOf(html) {
  const els = parse(html);
  const textOf = (el) => [...el.texts, ...el.children.flatMap(textOf)];
  const wrap = (el) => ({
    el,
    get disabled() {
      return 'disabled' in el.attrs;
    },
    get innerText() {
      return textOf(el).join('\n');
    },
    getAttribute: (n) => (n in el.attrs ? el.attrs[n] : null),
    setAttribute: (n, v) => void (el.attrs[n] = v),
    removeAttribute: (n) => void delete el.attrs[n],
  });
  const inListbox = (el) => {
    for (let p = el.parent; p; p = p.parent) if (p.attrs.role === 'listbox') return true;
    return false;
  };
  return {
    querySelectorAll(sel) {
      if (sel === '[role="listbox"] [role="option"]') {
        return els.filter((e) => e.attrs.role === 'option' && inListbox(e)).map(wrap);
      }
      const marked = /^\[([a-z-]+)\]$/.exec(sel);
      if (marked) return els.filter((e) => marked[1] in e.attrs).map(wrap);
      throw new Error(`picker-selftest: the micro DOM does not implement ${sel}`);
    },
  };
}

/** Runs a page-side expression against fixture markup. */
const run = (html, script) => new Function('document', `return ${script};`)(documentOf(html));

// --- the markup of an OPEN picker, as Picker.svelte renders it (role options, no value attribute) ---
const MEMBER = caption('chat_role_member');
const MODERATOR = caption('chat_role_moderator');
const ADMIN = caption('chat_role_admin');
const ROLE_LABEL = caption('chat_assign_role_label');

const option = (label, { selected = false, disabled = false, description = '' } = {}) =>
  `<button type="button" role="option" aria-selected="${selected}"${disabled ? ' disabled' : ''}>` +
  `<span><span>${label}</span>${description ? `<span>${description}</span>` : ''}</span></button>`;
const openPicker = (...options) =>
  `<button aria-haspopup="listbox" aria-label="${ROLE_LABEL} - ${MEMBER}"><span>${MEMBER}</span></button>` +
  `<div role="listbox" aria-label="${ROLE_LABEL}">${options.join('')}</div>`;

const OPEN = openPicker(
  option(MEMBER, { selected: true }),
  option(MODERATOR, { description: 'can moderate' }),
  option(ADMIN)
);
const offered = (html) => JSON.parse(run(html, PICKER_OPTIONS_JS));

// 1. the snippet reads the labels, the selection, and ignores a description line
const seen = offered(OPEN);
check('reads three options', seen.length === 3, JSON.stringify(seen));
check(
  'reads labels, first line only',
  seen.map((o) => o.label).join('|') === [MEMBER, MODERATOR, ADMIN].join('|'),
  JSON.stringify(seen)
);
check('reads the selected option', seen[0].selected && !seen[1].selected);
check('a closed picker offers nothing', offered(openPicker()).length === 0);
check('PICKER_IS_OPEN is true on an open list', run(OPEN, PICKER_IS_OPEN) === true);
check('PICKER_IS_OPEN is false on a closed one', run(openPicker(), PICKER_IS_OPEN) === false);

// 2. the decision
const pick = (html, label) => decidePickerChoice(offered(html), label);
check('picks by label', pick(OPEN, ADMIN).ok && pick(OPEN, ADMIN).index === 2);
check('reports an already-selected option', pick(OPEN, MEMBER).alreadySelected === true);
check('trims the wanted label', pick(OPEN, ` ${MODERATOR} `).index === 1);

// 3. the refusals each carry their own precise reason
const gone = pick(OPEN, 'Inexistant');
check('not found is refused', gone.ok === false && gone.reason.startsWith('no-option:'), gone.reason);
check(
  'not found lists what WAS offered',
  [MEMBER, MODERATOR, ADMIN].every((l) => gone.reason.includes(JSON.stringify(l))),
  gone.reason
);
check('an empty list is its own reason', decidePickerChoice([], ADMIN).reason === 'no-options');
const twice = pick(openPicker(option(ADMIN), option(ADMIN)), ADMIN);
check('two identical labels are ambiguous, never a guess', twice.reason?.startsWith('ambiguous:'));
const off = pick(openPicker(option(MEMBER), option(ADMIN, { disabled: true })), ADMIN);
check('a disabled option is refused', off.reason?.startsWith('disabled-option:'), off.reason);
const prefix = pick(openPicker(option('Admins uniquement'), option('Admins et moderateurs uniquement')), 'Admins');
check('a prefix is not a match', prefix.reason?.startsWith('no-option:'), prefix.reason);

// 4. marking the option for the hit-tested click, and unmarking it
const doc = documentOf(OPEN);
const marker = (document) => document.querySelectorAll(`[${OPTION_MARK}]`).length;
const exec = (script) => new Function('document', `return ${script};`)(doc);
check('marks option 1', exec(markOptionJs(1)) === 'marked' && marker(doc) === 1);
check(
  'the marked option is the chosen one',
  doc.querySelectorAll(`[${OPTION_MARK}]`)[0].innerText.startsWith(MODERATOR)
);
check('re-marking moves the mark', exec(markOptionJs(2)) === 'marked' && marker(doc) === 1);
check('marking a vanished option says so', exec(markOptionJs(9)) === 'gone' && marker(doc) === 0);
exec(markOptionJs(0));
exec(UNMARK_OPTION_JS);
check('unmarking clears it', marker(doc) === 0);

// 5. the trigger's accessible name
check('trigger selector is scoped by label', triggerByLabel(ROLE_LABEL).includes(`${ROLE_LABEL} - `));
check('reads the current label', currentLabelOf(`${ROLE_LABEL} - ${ADMIN}`, ROLE_LABEL) === ADMIN);
check('a foreign picker is null', currentLabelOf(`Autre - ${ADMIN}`, ROLE_LABEL) === null);

if (failures > 0) {
  console.error(`picker-selftest: ${failures} failure(s)`);
  process.exit(1);
}
console.log('picker-selftest OK');
