/**
 * ADDING A MEMBER TO A GROUP - one gesture, because three call sites each learnt a different third
 * of it and none of them held all three.
 *
 * `invite.mjs` learnt all of it the hard way and kept it to itself; READ-10 hand-rolled a shorter
 * version and had NEVER produced a verdict, dying at this step on every run; `del1.mjs` has its own
 * again. The three lessons, each of which cost a run:
 *
 *   1. **THE RESULT LIST IS PORTALLED**, so neither obvious scoping can reach it. Unscoped, "a
 *      button whose text starts with the name" matches the SIDEBAR's own DM row for that person -
 *      the first attempt clicked it, navigated away from the group entirely, and the run timed out
 *      blaming a disabled button. Scoped to the modal it finds NOTHING, because the dropdown is a
 *      `<ul class="fixed z-[290]">` mounted at the body, outside the modal's subtree, and its
 *      options are `<li>`, not `<button>`. So: select the ONE floating list that MENTIONS THE NAME.
 *      READ-10's version took `[0]` of any small fixed list and clicked a global `'ul li, ol li'` -
 *      which is the same fault with the same shape, waiting to pick someone else's list.
 *   2. **IT MUST BE A REAL MOUSE CLICK AT COORDINATES.** `element.click()` fires, the option text
 *      comes back, and "Envoyer l'invitation" stays DISABLED: the component listens for a pointer
 *      sequence the synthetic call never produces. So locate the option and dispatch at its centre.
 *   3. **THE POST-CONDITION IS THE PICKER CLOSING**, not a roster count. The commit is a network
 *      round trip - stage, `POST /api/mls/commit`, merge, fan-out - so the click returning proves
 *      nothing. READ-10 waited for `MEMBRES (2)` instead, which is a rendering of the outcome rather
 *      than the outcome, and one arrangement of the panel away from being wrong.
 *
 * Separate module rather than a fourth function in `groupnav.mjs`: that file is about FINDING and
 * OPENING a conversation, and this is a membership commit. Keeping them apart is what stops the next
 * reader importing half of one to get the other.
 */
import { evaluate, realClick, until } from './chat.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Opens the group settings panel of the conversation already on screen.
 *
 * The label is bare - `Ajouter`, not `Ajouter un membre`, which is what a guessed matcher looked for
 * and missed.
 */
export async function openGroupSettings(cx) {
  await realClick(cx, '[aria-label="Paramètres du groupe"]');
  await until(cx, `/Quitter le groupe/.test(document.body.innerText)`, 10000);
  await sleep(1200);
}

/**
 * Focuses the picker's search field and replaces whatever is in it with `who`.
 *
 * The field is addressed by its id where it has one: a `realClick` on a placeholder match is a text
 * search over the whole document, and this input's placeholder is a common word.
 */
async function typeQuery(cx, who) {
  const searchId = await evaluate(
    cx,
    `(function () {
      var i = [].slice.call(document.querySelectorAll('input')).filter(function (x) { return /rechercher/i.test(x.placeholder || ''); }).pop();
      if (!i) return null;
      i.focus();
      i.value = '';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return i.id || 'NO_ID';
    })()`
  );
  if (!searchId) throw new Error('addMember: no search field in the member picker');
  if (searchId !== 'NO_ID') await realClick(cx, `#${searchId}`);
  await cx.send('Input.insertText', { text: who });
  await sleep(2500);
}

/**
 * The coordinates of the option for `who` in the portalled result list, or null if it offers none.
 *
 * NON-THROWING BY DESIGN, because "this account is not offered" is the ANSWER when the caller is
 * identifying the peer by elimination - the picker never offers an existing member or yourself.
 */
async function optionFor(cx, who) {
  return JSON.parse(
    await evaluate(
      cx,
      `(function () {
        var want = ${JSON.stringify(who.toLowerCase())};
        var list = [].slice.call(document.querySelectorAll('ul, ol')).filter(function (e) {
          var t = e.innerText || '';
          return t.toLowerCase().indexOf(want) !== -1 && t.length < 400 && /fixed/.test((e.className || '').toString());
        })[0];
        if (!list) return JSON.stringify(null);
        var opt = [].slice.call(list.querySelectorAll('li, button, [role=option]')).filter(function (x) {
          return (x.innerText || '').trim().toLowerCase().indexOf(want) === 0;
        })[0] || list.firstElementChild;
        if (!opt) return JSON.stringify(null);
        var r = (opt.querySelector('button, [role=option]') || opt).getBoundingClientRect();
        return JSON.stringify({
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          // THE BACKSLASH IS DOUBLED, and it has to be. This whole expression is a JS template
          // literal, so a single backslash in it is an ESCAPE: the whitespace class reached the page
          // with its backslash eaten and matched the LETTER s, so this stripped every s out of the
          // option text - the value addAnyMember RETURNS as "who was invited". READ-10 logged
          // invited the owner under a name missing every s in it, and the same eaten backslash split a
          // sidebar row into "conver" and "ation" in deadrows.mjs an hour later.
          //
          // No backticks in this comment either: a backtick inside a template literal CLOSES it, and
          // quoting the pattern the natural way turned the rest of the function into code.
          text: (opt.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40),
        });
      })()`
    )
  );
}

/** A real pointer sequence at a point - `element.click()` leaves the submit button disabled. */
async function pointerAt(cx, { x, y }) {
  await cx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cx.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    });
  }
  await sleep(1200);
}

/** Submits the picked selection and returns once the picker has closed. */
async function submitInvite(cx) {
  await until(
    cx,
    `(function () {
      var b = [].slice.call(document.querySelectorAll('button')).filter(function (x) { return /Envoyer l'invitation/.test(x.innerText || ''); })[0];
      return !!b && !b.disabled;
    })()`,
    8000
  );
  await realClick(cx, "text=Envoyer l'invitation");
  // LESSON 3: the picker closing is the commit landing.
  await until(cx, `!/Envoyer l'invitation/.test(document.body.innerText)`, 25000);
  await sleep(3000);
}

/** Opens the member picker on the group whose settings panel is already open. */
async function openPicker(cx) {
  // The label is bare - `Ajouter`, not `Ajouter un membre`, which a guessed matcher looked for and
  // missed.
  await realClick(cx, 'text=Ajouter');
  await sleep(1800);
}

/**
 * Invites `who` into the group whose pane is open, and returns the option text that was picked.
 *
 * @param cx a connected client, with the group open
 * @param who a display name as the picker renders it
 * @throws if the search field is absent, the name is not offered, or the commit does not land
 */
export async function addMember(cx, who, { openSettings = true, openPickerFirst = true } = {}) {
  if (openSettings) await openGroupSettings(cx);
  if (openPickerFirst) await openPicker(cx);
  await typeQuery(cx, who);
  const spot = await optionFor(cx, who);
  if (!spot) throw new Error(`addMember: the picker offers no ${who}`);
  await pointerAt(cx, spot);
  await submitInvite(cx);
  return spot.text;
}

/**
 * Invites whichever of `candidates` the picker will accept, and returns that name.
 *
 * SEARCH BY ELIMINATION IS NOT A WORKAROUND, it is the only reliable way to learn who the peer is:
 * the picker never offers an existing member or yourself, so trying the accounts in turn and watching
 * one be accepted is what identifies them. Parsing a name off the page picked the WRONG account in
 * `del1.mjs`, which is where that comment comes from.
 *
 * **THE PICKER IS OPENED ONCE**, and that is not a micro-optimisation - it is the whole correctness
 * of this function. The first version called `addMember` per candidate, so every refusal re-clicked
 * "Ajouter" and STACKED another dialog: the run left W2 holding "Parametres du groupe" AND "Ajouter
 * des membres" at once, and the next preflight could not clear them - it found the close button and
 * reported it covered by the newer dialog's own backdrop. A retry loop that re-enters the surface it
 * is retrying inside is how a check breaks the rig for every check after it.
 */
export async function addAnyMember(cx, candidates, { openSettings = true } = {}) {
  if (openSettings) await openGroupSettings(cx);
  await openPicker(cx);
  const refused = [];
  for (const who of candidates) {
    await typeQuery(cx, who);
    const spot = await optionFor(cx, who);
    if (!spot) {
      refused.push(`${who}: not offered`);
      continue;
    }
    await pointerAt(cx, spot);
    await submitInvite(cx);
    return spot.text;
  }
  throw new Error(
    `addAnyMember: none of ${candidates.length} candidate(s) could be invited - ${refused.join(' | ')}`
  );
}
