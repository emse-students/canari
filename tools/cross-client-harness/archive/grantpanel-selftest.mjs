/**
 * THE GRANT CLICKS THE PANEL'S OWN "ADD", NEVER A JOIN-REQUEST BANNER'S (`grantpanel.mjs`).
 *
 *   bun archive/grantpanel-selftest.mjs
 *
 * The snippet that reads the live page is run HERE, unchanged, against a fixture tree shaped like
 * `ChannelSettingsPanel.svelte`'s "add a user" section next to a banner carrying its own "Ajouter".
 * The captions are READ FROM `fr.json` through `caption`, never spelt.
 *
 * A micro DOM stands in for a browser (a fresh CI checkout has no frontend dependencies). It
 * implements only what the snippet uses - `querySelector` by placeholder, `querySelectorAll` for
 * `button`, `p` and the mark, `parentElement`, `innerText`, `textContent`, `disabled` and the
 * attribute calls - so a snippet that grows past that fails here, loudly.
 */
import { GRANT_ADD_MARK, markGrantAddJs } from '../grantpanel.mjs';
import { caption } from '../messages.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

const PLACEHOLDER = caption('chat_search_user_placeholder');
const ADD = caption('common_add_button');
const SECTION = caption('chat_channel_add_user_label');
const JS = markGrantAddJs({ placeholder: PLACEHOLDER, add: ADD, section: SECTION });

/** An element: `tag`, attributes, its own text and children; `parentElement` is wired by `doc`. */
const h = (tag, attrs = {}, ...children) => ({
  tag,
  attrs: { ...attrs },
  text: children.filter((c) => typeof c === 'string').join(''),
  children: children.filter((c) => typeof c !== 'string'),
  parentElement: null,
});

function doc(root) {
  const all = [];
  const walk = (el, parent) => {
    el.parentElement = parent;
    all.push(el);
    el.children.forEach((c) => walk(c, el));
  };
  walk(root, null);
  const below = (el) => el.children.flatMap((c) => [c, ...below(c)]);
  const textOf = (el) => el.text + el.children.map(textOf).join('');
  const match = (sel) => {
    if (sel === 'button' || sel === 'p') return (el) => el.tag === sel;
    if (sel === `[${GRANT_ADD_MARK}]`) return (el) => GRANT_ADD_MARK in el.attrs;
    throw new Error(`micro DOM: unsupported selector ${sel}`);
  };
  for (const el of all) {
    Object.defineProperties(el, {
      innerText: { get: () => textOf(el) },
      textContent: { get: () => textOf(el) },
      disabled: { get: () => 'disabled' in el.attrs },
    });
    el.querySelectorAll = (sel) => below(el).filter(match(sel));
    el.getAttribute = (n) => (n in el.attrs ? el.attrs[n] : null);
    el.setAttribute = (n, v) => void (el.attrs[n] = String(v));
    el.removeAttribute = (n) => void delete el.attrs[n];
  }
  return {
    querySelector: (sel) => {
      if (sel !== `input[placeholder=${JSON.stringify(PLACEHOLDER)}]`)
        throw new Error(`micro DOM: unsupported selector ${sel}`);
      return all.find((el) => el.tag === 'input' && el.attrs.placeholder === PLACEHOLDER) ?? null;
    },
    querySelectorAll: (sel) => all.filter(match(sel)),
  };
}

const run = (document) => new Function('document', `return ${JS};`)(document);
const throwsNamed = (f, name) => {
  try {
    f();
    return false;
  } catch (e) {
    return String(e?.message).startsWith(name);
  }
};

/** The banner and the panel, side by side under `body`; `panelButton` false drops the panel's button. */
function page({ panelButton = true, disabled = false, staleOnBanner = false, field = true } = {}) {
  const banner = h('button', staleOnBanner ? { [GRANT_ADD_MARK]: '1' } : {}, ADD);
  const add = panelButton ? h('button', disabled ? { disabled: '' } : {}, ADD) : null;
  const row = h(
    'div',
    {},
    h('div', {}, field ? h('input', { placeholder: PLACEHOLDER }) : h('span', {})),
    ...(add ? [add] : [])
  );
  const body = h(
    'body',
    {},
    h('div', {}, h('p', {}, 'Une demande'), banner),
    h('div', {}, h('div', {}, h('p', {}, SECTION), row))
  );
  return { document: doc(body), banner, add };
}

{
  const p = page();
  ok(
    'an enabled panel button is marked and answered true',
    run(p.document) === true && GRANT_ADD_MARK in p.add.attrs
  );
  ok('the banner beside it is never marked', !(GRANT_ADD_MARK in p.banner.attrs));
}
{
  const p = page({ disabled: true });
  ok(
    'a disabled panel button is marked and answered false (waited on, not clicked)',
    run(p.document) === false && GRANT_ADD_MARK in p.add.attrs
  );
}
{
  const p = page({ staleOnBanner: true });
  run(p.document);
  ok(
    'a stale mark on the banner is removed when the panel button is marked',
    !(GRANT_ADD_MARK in p.banner.attrs) && GRANT_ADD_MARK in p.add.attrs
  );
}
{
  const p = page({ panelButton: false });
  ok(
    'a panel with no add button THROWS, named, beside a banner with one',
    throwsNamed(() => run(p.document), 'grant-panel-no-add-button')
  );
  ok('...and the banner is NOT marked', !(GRANT_ADD_MARK in p.banner.attrs));
}
{
  const p = page({ field: false });
  ok(
    'no search field THROWS, named',
    throwsNamed(() => run(p.document), 'grant-panel-no-field')
  );
}
{
  const input = h('input', { placeholder: PLACEHOLDER });
  const banner = h('button', {}, ADD);
  const d = doc(h('body', {}, h('div', {}, banner), h('div', {}, input)));
  ok(
    'a field outside the section never climbs to the banner: it THROWS, named',
    throwsNamed(() => run(d), 'grant-panel-no-section') && !(GRANT_ADD_MARK in banner.attrs)
  );
}

if (failures) {
  console.error(`grantpanel-selftest: ${failures} failure(s)`);
  process.exit(1);
}
console.log('grantpanel-selftest: ok');
