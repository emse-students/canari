/**
 * THE APP'S OWN FRENCH, READ FROM ITS MESSAGE FILE - and nothing else.
 *
 * **WHY THIS IS NOT IN `comm.mjs`, WHERE IT LIVED UNTIL 2026-09-21.** Everything here is a pure
 * function of `frontend/messages/<locale>.json`: no browser, no CDP, no devices, no accounts. It
 * sat in `comm.mjs`, which reaches `chat.mjs` and through it the out-of-tree `names.mjs` - so a CI
 * gate wanting to check these keys could not import them on a fresh checkout. `gate-selftest.mjs`
 * refused `caption-selftest.mjs` for exactly that, which is the refusal working: a self-test that
 * cannot run in CI is a self-test that will not run.
 *
 * `comm.mjs` re-exports every name below, so no caller moved - the same shape `OVERLAYS` took when
 * it left `chat.mjs`.
 */
import { readFileSync } from 'node:fs';

const LOCALE = process.argv.includes('--locale')
  ? process.argv[process.argv.indexOf('--locale') + 1]
  : 'fr';

/** Every user-visible string the app can render, in the locale the clients are running. */
const MESSAGES = JSON.parse(
  readFileSync(new URL(`../../frontend/messages/${LOCALE}.json`, import.meta.url), 'utf8')
);

/**
 * The wordings a Paraglide key can render, whatever shape the message file gives it.
 *
 * ONE READER FOR TWO SHAPES. A message is either a plain string or, since the app started
 * pluralising, an array of variant objects whose `match` maps a selector to a wording. Every helper
 * below used to test `typeof value !== 'string'` and report a plural as a MISSING KEY - see
 * {@link caption} for what that cost.
 *
 * @param key Paraglide key.
 * @param who The calling helper's name, so the throw accuses the right one.
 * @returns Every wording the key can produce; one entry for a plain message.
 */
export function wordingsOf(key, who = 'wordingsOf') {
  const value = MESSAGES[key];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    const variants = value.flatMap((v) => Object.values(v?.match ?? {})).filter(Boolean);
    if (variants.length > 0) return variants;
  }
  throw new Error(`${who}: no message '${key}' in ${LOCALE}.json - the key was renamed or is a typo`);
}

/**
 * The ONE wording a key has, for the helpers that can only work with one.
 *
 * `captionWith`, `saysMessage` and `commonTail` all interpolate or slice a single string, and all
 * three used to answer *"renamed or a typo"* for a plural - the same misdiagnosis {@link caption}
 * made, in three more places. One refusal, written once.
 */
function loneWordingOf(key, who) {
  const wordings = wordingsOf(key, who);
  if (wordings.length > 1) {
    throw new Error(
      `${who}: '${key}' is a PLURAL (${wordings.map((w) => JSON.stringify(w)).join(' / ')}) - ` +
        `it renders differently per count, so use pluralPattern('${key}')`
    );
  }
  return wordings[0];
}

/**
 * The text a control actually renders, by its Paraglide key.
 *
 * THROWS ON AN UNKNOWN KEY rather than returning undefined: a `text=undefined` selector matches
 * nothing and fails fifteen seconds later as "the control is missing", which is a diagnosis of the
 * app for a typo in the harness. A key that no longer exists is a harness fault and says so here.
 *
 * Parameterised messages are refused for the same reason. `{count} max` cannot be matched literally,
 * so a check that needs one must match its stable half explicitly and knowingly.
 *
 * **AND A PLURAL IS ITS OWN REFUSAL, WITH ITS OWN SENTENCE.** `chat_community_member_count_label`
 * went from `"Membre(s)"` to `{count} membre` / `{count} membres` on 2026-09-09 (#478), and this
 * function answered *"the key was renamed or is a typo"* for a key that was neither - it was
 * present, correct, and no longer a single string. `openCommunityMembers` therefore threw for
 * twelve days, and nothing noticed because no row had opened that panel since. A refusal that
 * names the wrong cause sends the next reader to `fr.json` looking for a key that is right there.
 * Use {@link pluralPattern} for these.
 */
export function caption(key) {
  const value = loneWordingOf(key, 'caption');
  if (value.includes('{')) {
    throw new Error(`caption: '${key}' is parameterised ("${value}") - match its stable half instead`);
  }
  return value;
}

/**
 * A regular expression SOURCE matching a plural message however the app chose to render it.
 *
 * WHY A PATTERN AND NOT A SHARED TAIL. {@link commonTail} answers the same question for several
 * DIFFERENT keys, where the shared ending is long enough to be an anchor by itself. The variants of
 * ONE plural share almost nothing - `{count} membre` and `{count} membres` share `" membre"`, six
 * characters after trimming - and an `indexOf` on that matches a role label, a heading, and the
 * count itself with no way to tell which was found. A count is also the one thing a check cannot
 * know in advance, which is why the number is matched as a number rather than filled in.
 *
 * Still derived from the app's own message file, exactly as every other helper here: a reworded
 * string moves the anchor, and a renamed key throws instead of silently matching nothing.
 *
 * @param key Paraglide key naming a plural message.
 * @returns A regex source, e.g. `(?:\d+ membre|\d+ membres)`.
 */
export function pluralPattern(key) {
  const wordings = wordingsOf(key, 'pluralPattern');
  if (wordings.length < 2) {
    throw new Error(`pluralPattern: '${key}' is not a plural - use caption('${key}')`);
  }
  // THE PLACEHOLDER IS THE ONLY THING NOT ESCAPED, and it becomes a number rather than anything:
  // `.+` would let the pattern span a whole paragraph and match two unrelated sentences as one.
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const variants = wordings.map((w) =>
    w
      .split(/\{[A-Za-z0-9_]+\}/)
      .map(escape)
      .join('\\d+')
  );
  return `(?:${variants.join('|')})`;
}

/**
 * A PARAMETERISED message, rendered with the values the app would render it with.
 *
 * {@link caption} refuses these, correctly: `{count} max` cannot be matched literally and a check
 * that tried would fail fifteen seconds later as "the control is missing". But some controls have
 * no other stable name - an unjoined private salon's row is named entirely by
 * `chat_channel_join_as_admin_aria`, placeholder and all - and spelling the French out in the check
 * would mean a reworded string turns the assertion into a silent no-op.
 *
 * So the message is still READ FROM THE APP'S OWN FILE and the placeholders are filled here. A
 * placeholder left over is a throw, not a selector nothing matches: `{name}` surviving into a
 * selector is the exact failure `caption` exists to prevent.
 *
 * @param key Paraglide key.
 * @param values Placeholder name to value, e.g. `{ name: 'c13-abc' }`.
 */
export function captionWith(key, values) {
  const value = loneWordingOf(key, 'captionWith');
  const filled = Object.entries(values).reduce(
    (text, [name, v]) => text.split(`{${name}}`).join(String(v)),
    value
  );
  if (filled.includes('{')) {
    throw new Error(`captionWith: '${key}' still has a placeholder after filling: "${filled}"`);
  }
  return filled;
}

/**
 * The longest ending several messages SHARE, as the app itself spells it.
 *
 * For finding a thing before judging what it says. Several controls have one shape and a wording
 * that varies with the data - an invitation card is worded three ways depending on whether it names
 * the inviter, the invitee, or neither - and a check that looks for the wording it EXPECTS cannot
 * tell an absent card from a card carrying one of the others. Both answer zero, and only one of them
 * is a delivery loss.
 *
 * Derived from the message file rather than spelt here, so a reworded string moves the anchor with
 * it. It THROWS on a tail too short to be a selector: three messages that share only a full stop
 * would otherwise hand back an anchor matching every bubble on screen, which is the vacuous count
 * this exists to prevent.
 *
 * @param keys Paraglide keys, parameterised or not.
 * @returns The shared tail, at least 8 characters.
 */
export function commonTail(...keys) {
  const values = keys.map((k) => loneWordingOf(k, 'commonTail'));

  let tail = '';
  for (let i = 1; i <= Math.min(...values.map((v) => v.length)); i++) {
    const candidate = values[0].slice(-i);
    if (!values.every((v) => v.endsWith(candidate))) break;
    tail = candidate;
  }

  if (tail.trim().length < 8) {
    throw new Error(
      `commonTail: ${keys.join(', ')} share only ${JSON.stringify(tail)} - too short to anchor on`
    );
  }
  return tail;
}

/**
 * Whether `text` is `key` AS RENDERED - its literal parts, in order, anything at its placeholders.
 *
 * {@link captionWith} answers the other question and needs the value the app will interpolate. That
 * is fine for a marker this rig invented and wrong for a DISPLAY NAME: `names.mjs` holds what the
 * sidebar is searched by, a first name, while a card is worded with the name the profile resolves
 * to. Filling the placeholder with the first one builds a sentence the app never renders, and the
 * assertion then reports the card as missing - which is what COMM-4 did on 2026-08-20, twice.
 *
 * Anchored at both ends when the message is: `msg_channel_invite_description_by` and
 * `msg_channel_invite_description` differ only in their opening words, so a check that merely looked
 * for the shared ending would call one the other.
 *
 * @param key Paraglide key.
 * @param text What is on screen.
 */
export function saysMessage(key, text) {
  const value = loneWordingOf(key, 'saysMessage');
  const parts = value.split(/\{[A-Za-z0-9_]+\}/);
  const said = String(text ?? '').trim();

  if (parts.length === 1) return said === value;
  if (parts[0] && !said.startsWith(parts[0])) return false;
  if (parts[parts.length - 1] && !said.endsWith(parts[parts.length - 1])) return false;

  let at = 0;
  for (const part of parts) {
    if (!part) continue;
    const found = said.indexOf(part, at);
    if (found === -1) return false;
    at = found + part.length;
  }
  return true;
}

/** `text=` selector for a control named by a Paraglide key. */
export const control = (key) => `text=${caption(key)}`;
