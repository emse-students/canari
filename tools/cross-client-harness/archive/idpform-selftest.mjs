/**
 * The rig's sign-in reads the MiConnect terms page as a stage it answers, not as a stall.
 *
 *   bun idpform-selftest.mjs
 *
 * WHY. Blueprint `45-consent.yaml` (held in `infrastructure/authentik/blueprints/held/`) adds a
 * terms page after the password for every account whose `attributes.cgu_version` is not the current
 * one. `login.mjs` knew three shapes - `cas`, `authentik-uid`, `authentik-password` - and the terms
 * page is none of them, so the loop would have waited on it and reported "never gave way". The
 * backlog makes "the harness accounts carry the version, or `login.mjs` ticks the box" a condition of
 * lifting the hold; this pins the second half without a browser, an estate or an identity provider.
 *
 * The page-side code is the SAME source the page runs (`idpform.mjs` ships it with `.toString()`), so
 * evaluating `FORM_SHAPE` against a fake document here exercises the string `login.mjs` sends.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyIdpForm, deepVisible, FORM_SHAPE, stageTable, tickScript } from '../idpform.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

/**
 * A minimal element: matches selectors of the forms the classifier uses, has a size, maybe a
 * shadow root. Only what `deepVisible` and `classifyIdpForm` read.
 */
const el = ({ tag = 'input', name, type, id, visible = true, checked = false, shadow } = {}) => ({
  tag,
  name,
  type,
  id,
  checked,
  shadowRoot: shadow ?? null,
  getBoundingClientRect: () => (visible ? { width: 100, height: 20 } : { width: 0, height: 0 }),
  click() {
    this.checked = !this.checked;
  },
});

const matches = (e, sel) => {
  if (sel === '*') return true;
  const attr = /^(\w+)?\[(\w+)=([^\]]+)\]$/.exec(sel);
  if (attr) return (!attr[1] || e.tag === attr[1]) && e[attr[2]] === attr[3];
  if (sel.startsWith('#')) return e.id === sel.slice(1);
  return e.tag === sel;
};

/** A node holding `children`, queryable the way the page code queries `document` and shadow roots. */
const root = (children) => ({
  querySelectorAll: (sel) => children.filter((e) => matches(e, sel)),
  querySelector: (sel) => children.find((e) => matches(e, sel)) ?? null,
});

/** Authentik's hidden autofill trio, present on every stage. */
const autofill = () => [
  el({ name: 'username', type: 'text', visible: false }),
  el({ name: 'password', type: 'password', visible: false }),
  el({ name: 'code', type: 'text', visible: false }),
];

/** A flow executor whose stage lives one shadow root down, as authentik renders it. */
const authentikPage = (stageInputs) => {
  const stage = el({ tag: 'ak-stage', shadow: root([...stageInputs, el({ tag: 'button', type: 'submit' })]) });
  return root([stage, ...autofill()]);
};

const shapeOf = (doc) => classifyIdpForm((sel) => deepVisible(sel, doc), doc);

/** Runs the exact string `login.mjs` evaluates, against a fake `document`. */
const evaluateInPage = (expr, doc) => new Function('document', `return ${expr};`)(doc);

const termsPage = () =>
  authentikPage([el({ tag: 'p', name: 'cgu_notice' }), el({ name: 'cgu_accept', type: 'checkbox' })]);
const uidPage = () => authentikPage([el({ name: 'uidField', type: 'text' })]);
const passwordPage = () => authentikPage([el({ name: 'password', type: 'password' })]);
const casPage = () => root([el({ id: 'username', type: 'text' }), el({ id: 'password', type: 'password' })]);

console.log('[idpform] which stage is on screen');
ok('the terms page is a stage of its own', shapeOf(termsPage()) === 'authentik-terms');
ok('the identifier page is still the identifier', shapeOf(uidPage()) === 'authentik-uid');
ok('the password page is still the password', shapeOf(passwordPage()) === 'authentik-password');
ok('the CAS page is still CAS', shapeOf(casPage()) === 'cas');
ok('the hidden autofill trio alone is no stage', shapeOf(root(autofill())) === null);
ok('the string the page runs agrees on the terms page', evaluateInPage(FORM_SHAPE, termsPage()) === 'authentik-terms');
ok('the string the page runs agrees on the password page', evaluateInPage(FORM_SHAPE, passwordPage()) === 'authentik-password');

console.log('[idpform] what answers the terms page');
const terms = stageTable({ username: 'u', password: 'p' })['authentik-terms'];
ok('it types nothing', terms.fields.length === 0);
ok('it ticks cgu_accept', terms.ticks.length === 1 && terms.ticks[0] === 'input[name=cgu_accept]');
const page = termsPage();
ok('the tick ends ticked', evaluateInPage(tickScript('input[name=cgu_accept]'), page) === 'ticked');
ok('a second tick leaves it ticked, never toggles it off', evaluateInPage(tickScript('input[name=cgu_accept]'), page) === 'ticked');
ok('a missing box is reported, not assumed', evaluateInPage(tickScript('input[name=cgu_accept]'), uidPage()) === 'missing');

console.log('[idpform] login.mjs uses this module, not a private copy');
const login = readFileSync(join(ROOT, 'login.mjs'), 'utf8');
ok('login.mjs imports the shared stages', /from '\.\/idpform\.mjs'/.test(login));
ok('login.mjs ticks what a stage asks it to tick', /\.ticks\b/.test(login) && /tickScript\(/.test(login));
ok('login.mjs keeps no FORM_SHAPE of its own', !/const FORM_SHAPE\s*=/.test(login));

console.log(
  failures
    ? `[idpform] ${failures} FAILURE(S) - a harness login would stall on the MiConnect terms page`
    : '[idpform] clean - the terms page is classified and answered by one tick'
);
process.exit(failures ? 1 : 0);
