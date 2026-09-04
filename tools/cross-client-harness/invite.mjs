/**
 * Invites a user into the open group conversation - i.e. produces an MLS **Add commit**.
 *
 * This is the campaign's only cheap, deterministic epoch generator. `ChannelService` does no MLS at
 * all (channels use a separate key-bootstrap scheme), there is no self-update/rotation primitive in
 * `mls-core`, and leaving a group deliberately commits nothing - so invite (Add) and remove (Remove)
 * on a group conversation are the entire menu. HEAL-W1 needs the epoch to advance while the device
 * under test STAYS a member, which is what an invite does and what removing that device does not.
 *
 * EVERY STEP STARTS FROM A KNOWN OVERLAY STATE, and that is not defensive coding. This app's panels
 * hide their own triggers: a run that leaves the group panel or the add-member modal open makes the
 * NEXT run fail with "no stable element" for a control that is plainly in the DOM and not disabled.
 * That cost three runs here. `settle()` is the fix, and it asserts rather than hopes.
 *
 *   bun invite.mjs --port 9223               (invites the OTHER party, whoever this port is)
 *   bun invite.mjs --port 9223 --probe       (report the panel, change nothing)
 */
import { APP_TAB, client, evaluate, goto, realClick, until } from './chat.mjs';
import { PORTS, peerNameFor } from './names.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const port = Number(arg('port', 9223));
const cx = await client(port, APP_TAB, { focus: false });

/**
 * WHO TO INVITE IS DERIVED FROM THE PORT, not spelt.
 *
 * The default used to be one account's first name, which made this file both a leak on a public
 * repository and wrong the moment it was pointed at the other browser: inviting yourself finds no
 * candidate and the check waits out its deadline blaming the app.
 */
const device = Object.keys(PORTS).find((d) => PORTS[d] === port);
const who = arg('who', device ? peerNameFor(device) : null);
if (!who) throw new Error(`--who is required: port ${port} is not one of ${Object.keys(PORTS).join(' ')}`);
const probeOnly = process.argv.includes('--probe');

/**
 * What is currently on screen, TOPMOST FIRST - and the order is the whole correctness of it.
 *
 * These overlays STACK: the member picker opens on top of the group panel, so both "Envoyer
 * l'invitation" and "Quitter le groupe" are in the DOM at once. Testing for the panel first
 * therefore identifies the layer UNDERNEATH, and `settle` then clicks a close button that the
 * modal is covering - not hit-testable, so the click fails, the state never changes, and the loop
 * runs out with "could not close the overlay". Identify the layer that is actually on top.
 */
const overlay = () =>
  evaluate(
    cx,
    `(function () {
      var t = document.body.innerText;
      if (document.querySelector('#new-group-name')) return 'new-conversation';
      if (/Envoyer l'invitation/.test(t)) return 'add-member';
      if (/Quitter le groupe/.test(t)) return 'group-panel';
      return 'none';
    })()`
  );

/** Closes whatever is open, by that overlay's OWN control, until nothing is. */
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    const state = await overlay();
    if (state === 'none') return state;
    await realClick(cx, state === 'group-panel' ? 'text=Fermer les paramètres du groupe' : 'text=Fermer').catch(
      () => {}
    );
    await sleep(1200);
  }
  const left = await overlay();
  if (left !== 'none') throw new Error(`could not close the overlay, still on ${left}`);
  return left;
};

const dump = async (stage) =>
  console.log(
    `\n=== ${stage} ===\n` +
      (await evaluate(
        cx,
        `JSON.stringify({
          tail: document.body.innerText.replace(/\\s+/g, ' ').slice(-500),
          inputs: [].slice.call(document.querySelectorAll('input')).map(function (i) { return { ph: i.placeholder || '', id: i.id || '' }; }),
          buttons: [].slice.call(document.querySelectorAll('button')).map(function (b) {
            return { t: ((b.innerText || '').trim() || (b.getAttribute('aria-label') || '')).replace(/\\s+/g, ' ').slice(0, 45), d: b.disabled };
          }).filter(function (x) { return x.t; })
        }, null, 1)`
      ))
  );

console.log(`[invite] overlay on entry: ${await overlay()} -> ${await settle()}`);

// OPEN THE TARGET GROUP RATHER THAN ASSUME IT IS OPEN. A conversation is whatever the last click
// left on screen, and a DM has no "Paramètres du groupe" at all - so an unrelated navigation makes
// this script fail claiming the control does not exist, when what does not exist is the group.
// `openGroup` rather than `openConversation`: a group row's first line is its one-letter avatar,
// so clicking by that line opens ANY group sharing the initial. See `groupnav.mjs`.
const group = arg('group', null);
if (group) {
  const { openGroup } = await import('./groupnav.mjs');
  console.log(`[invite] opened: ${await openGroup(cx, group, { navigate: true, label: 'invite' })}`);
}

await realClick(cx, '[aria-label="Paramètres du groupe"]');
await until(cx, `/Quitter le groupe/.test(document.body.innerText)`, 10000);
await sleep(1200);

if (probeOnly) {
  await dump('group panel');
  await settle();
  cx.close();
  process.exit(0);
}

// "Ajouter" opens the member picker. The label is bare - not "Ajouter un membre", which is what a
// guessed matcher looked for and missed.
await realClick(cx, 'text=Ajouter');
await sleep(1800);
await dump('member picker');

const searchId = await evaluate(
  cx,
  `(function () {
    var i = [].slice.call(document.querySelectorAll('input')).filter(function (x) { return /rechercher/i.test(x.placeholder || ''); }).pop();
    return i ? (i.id || 'NO_ID') : null;
  })()`
);
if (!searchId) throw new Error('no search field in the member picker');
if (searchId !== 'NO_ID') await realClick(cx, `#${searchId}`);
else await evaluate(cx, `[].slice.call(document.querySelectorAll('input')).filter(function (x) { return /rechercher/i.test(x.placeholder || ''); }).pop().focus()`);
await cx.send('Input.insertText', { text: who });
await sleep(3000);
await dump(`after typing ${who}`);

// THE RESULT LIST IS PORTALLED, so neither of the two obvious scopings can reach it.
//
// Unscoped "a button whose text starts with the name" matches the SIDEBAR's own DM row for that
// person - the first attempt clicked it and navigated away from the group entirely, while "Envoyer
// l'invitation" stayed disabled and the run timed out blaming the button. Scoping to the modal
// then found NOTHING, because the dropdown is a `<ul class="fixed z-[290]">` mounted at the body,
// outside the modal's subtree, and its options are `<li>`, not `<button>`.
//
// So address the dropdown itself: the one floating list that mentions the name. Same lesson as the
// portalled dropdown already in the durable rules - a portal breaks containment-based selectors,
// and the fix is to select the portal, never to widen the search.
//
// And it must be a REAL mouse click, not `element.click()`: the raw DOM call fired, the option text
// came back, and "Envoyer l'invitation" stayed disabled - the component listens for a pointer
// sequence the synthetic call never produces. So locate the option and dispatch at its coordinates.
const spot = JSON.parse(
  await evaluate(
    cx,
    `(function () {
      var list = [].slice.call(document.querySelectorAll('ul, ol')).filter(function (e) {
        var t = e.innerText || '';
        return t.toLowerCase().indexOf(${JSON.stringify(who.toLowerCase())}) !== -1 && t.length < 400 && /fixed/.test((e.className || '').toString());
      })[0];
      if (!list) return JSON.stringify(null);
      var opt = [].slice.call(list.querySelectorAll('li, button, [role=option]')).filter(function (x) {
        return (x.innerText || '').trim().toLowerCase().indexOf(${JSON.stringify(who.toLowerCase())}) === 0;
      })[0] || list.firstElementChild;
      if (!opt) return JSON.stringify(null);
      var r = (opt.querySelector('button, [role=option]') || opt).getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (opt.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40) });
    })()`
  )
);
const picked = spot?.text ?? null;
if (spot) {
  await cx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y, buttons: 0 });
  for (const type of ['mousePressed', 'mouseReleased'])
    await cx.send('Input.dispatchMouseEvent', {
      type,
      x: spot.x,
      y: spot.y,
      button: 'left',
      clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    });
  await sleep(1200);
}
if (!picked) throw new Error(`no search result for ${who}`);
console.log(`[invite] picked ${JSON.stringify(picked)}`);

await until(
  cx,
  `(function () {
    var b = [].slice.call(document.querySelectorAll('button')).filter(function (x) { return /Envoyer l'invitation/.test(x.innerText || ''); })[0];
    return !!b && !b.disabled;
  })()`,
  8000
);
await realClick(cx, "text=Envoyer l'invitation");

// The commit is a network round trip (stage -> POST /api/mls/commit -> merge -> fan-out), so the
// post-condition is the picker closing, not the click returning.
await until(cx, `!/Envoyer l'invitation/.test(document.body.innerText)`, 25000);
await sleep(3000);
console.log(`[invite] ${who} invited - Add commit submitted`);
await dump('after the invite');
await settle();

cx.close();
process.exit(0);
