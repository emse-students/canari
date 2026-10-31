/**
 * THE GROUP LINK AND ITS ASK - the gestures of the admission rows (`archive/admit.mjs`).
 *
 *   mintGroupLink(cx, name)          the open group's panel: "Generer un lien", the link read back
 *   followGroupLink(cx, url)         the joiner's side: the invitation page, "Rejoindre le groupe"
 *   askShown(cx, userId)             is the ask for `userId` on this member's screen (row or banner)
 *   awaitAsk(cx, userId, ms)         ... polled; the ms it took, or null
 *   answerAsk(cx, userId, choice)    the member's Add or Decline, on the ask's own row
 *
 * THE TOKEN IS A JOIN CAPABILITY and this repository is public: nothing here logs or returns it to a
 * record. `mintGroupLink` returns the URL to the caller, which hands it to the joiner and records only
 * its length (the rule `archive/grp.mjs` GRP-4 set).
 *
 * THE ASK IS ADDRESSED BY ITS PERSON, never by its position: `[data-join-request]` carries the
 * canonical user id (`JoinRequestRow.svelte`), compared case-folded because the canonical form folds
 * ASCII letters. It is the only place an ask shows: the app-wide banner is gone (2026-10-30).
 */
import { assertCampaignOwned } from '../campaign.mjs';
import { evaluate, goto, realClick, until } from '../chat.mjs';
import { SITE } from '../site.mjs';
import { openGroupSettings } from './addmember.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The `data-join-request` value on screen for `userId`, case-folded match; null when none. */
const ROW_OF = (userId) => `(function () {
  var want = ${JSON.stringify(String(userId).toLowerCase())};
  var el = [].slice.call(document.querySelectorAll('[data-join-request]')).filter(function (x) {
    return String(x.getAttribute('data-join-request')).toLowerCase() === want;
  })[0];
  return el ? el.getAttribute('data-join-request') : null;
})()`;

/** The banner's title (`join_request_title`), the one place an ask shows outside the conversation. */
const BANNER = `document.body.innerText.indexOf('Demande pour rejoindre une conversation') !== -1`;

/** The value of the panel's input holding a group link, or null while none does. */
const LINK_INPUT = `(function () { var i = [].slice.call(document.querySelectorAll('input')).filter(function (x) { return /\\/g\\/join\\//.test(x.value || ''); })[0]; return i ? i.value : null; })()`;

/**
 * Mints the open group's invitation link from its panel, and returns it.
 *
 * @param {string} name the group's name, for the R5 ownership guard: a link is a door into it
 * @returns {Promise<string>} the link, shaped `${SITE}/g/join/<token>` - asserted, never recorded
 */
export async function mintGroupLink(cx, name) {
  assertCampaignOwned({ kind: 'group', name }, 'mintGroupLink');
  await openGroupSettings(cx);
  await realClick(cx, 'text=Générer un lien');
  // THE LINK IS AN INPUT'S `value` PROPERTY, NEVER AN ATTRIBUTE: Svelte sets `value={shareLink}` as
  // the property, so `innerHTML` never carries it. The wait read `innerHTML` and timed out on a panel
  // already showing the link and "Lien copié" (ADM-1, 2026-10-25) - it waits on what it then reads.
  await until(cx, `${LINK_INPUT} !== null`, 20_000);
  const url = await evaluate(cx, LINK_INPUT);
  const prefix = `${SITE}/g/join/`;
  if (typeof url !== 'string' || !url.startsWith(prefix) || !/^[A-Za-z0-9_-]{8,}$/.test(url.slice(prefix.length))) {
    throw new Error(`mintGroupLink: the panel's link is not shaped ${prefix}<token> (length ${typeof url === 'string' ? url.length : 'none'})`);
  }
  return url;
}

/**
 * Follows a group link as the joiner: the invitation page, then its button. Returns once the page
 * says the request was SENT ("Demande envoyee !") - the joiner's waiting state - or throws with what
 * the page said instead.
 */
export async function followGroupLink(cx, url) {
  await goto(cx, new URL(url).pathname);
  await until(cx, `/Rejoindre le groupe/.test(document.body.innerText)`, 20_000);
  await realClick(cx, 'text=Rejoindre le groupe');
  try {
    await until(cx, `/Demande envoy/.test(document.body.innerText)`, 30_000);
  } catch {
    const said = String(await evaluate(cx, 'document.body.innerText')).slice(0, 200);
    throw new Error(`followGroupLink: the request was not sent - the page says: ${said}`);
  }
  return { waitingText: await evaluate(cx, `/En attente qu'un membre/.test(document.body.innerText)`) };
}

/** Whether this member's screen shows the ask for `userId`: its row in the conversation, or the banner. */
export async function askShown(cx, userId) {
  const row = await evaluate(cx, ROW_OF(userId));
  if (row) return 'row';
  return (await evaluate(cx, BANNER)) === true ? 'banner' : null;
}

/** Polls {@link askShown}; the ms until the ask showed, or null at the bound. */
export async function awaitAsk(cx, userId, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    if (await askShown(cx, userId)) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(500);
  }
}

/** Polls until the ask for `userId` has left this screen; the ms it took, or null at the bound. */
export async function awaitAskGone(cx, userId, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    if (!(await askShown(cx, userId))) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(1_000);
  }
}

/**
 * Answers the ask for `userId` on its OWN row (the conversation must be open on this member): the
 * first button is Add (`join_request_accept`), the second Decline (`join_request_decline`).
 *
 * @param {'approve'|'decline'} choice
 */
export async function answerAsk(cx, userId, choice) {
  const row = await evaluate(cx, ROW_OF(userId));
  if (!row) throw new Error(`answerAsk: no ask row for ${String(userId).slice(0, 8)} on this screen - open the conversation first`);
  await realClick(cx, `[data-join-request="${row}"] button:nth-of-type(${choice === 'approve' ? 1 : 2})`);
}
