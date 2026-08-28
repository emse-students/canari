/**
 * THE ONE ANSWER TO "can this client be asked a question yet", and the repair that gets it there.
 *
 * IT LIVED INSIDE `run.mjs`, WHICH IS A CLI, SO EVERY OTHER CALLER WENT WITHOUT IT. That is the
 * third time in one day the same shape bit: a predicate whose only home is an entry point is
 * re-implemented approximately by its neighbours, or simply omitted. `gate-probe.mjs` was the first
 * (three copies of "is the PIN gate up", the loosest deciding), `native-residue.mjs` the second (the
 * two-half wipe verdict, correct on the command line and wrong in every runner) - and this is the
 * third, measured on 2026-08-28: `healnew.mjs`'s `setTopology` brings a device up by calling
 * `launch.mjs start` and `pin.mjs`, neither of which can restore a SESSION, so HEAL-NEW-3 was run
 * against a W1 sitting on `/login` and failed on a premise about the fleet rather than on its own
 * question.
 *
 * AND THE MOVE FIXED A LIVE DEFECT BY ITSELF. The probe carried a FOURTH copy of the gate test,
 * keyed on `document.body.innerText` containing "PIN de chiffrement" - the exact string `/settings`
 * prints in its own security section. The preflight of every phase therefore read a client parked on
 * `/settings` as `LOCKED` and spent its four repair passes typing a PIN into a page with no prompt.
 * Importing `GATE_EXPR` is what removes it; there is now nowhere left for a fifth copy to hide.
 *
 * IT IS TWO FILES BECAUSE OF A GITIGNORE, AND THE SPLIT IS THE RIGHT ONE ANYWAY. Reading a device
 * needs `names.mjs` for its port, and that file is gitignored - it holds real display names and this
 * repository is PUBLIC - so anything importing it, three modules down, cannot run in the CI gate
 * (`gate-selftest.mjs` asserts exactly that). So THIS file is the pure predicate, importable by a
 * test on a machine with no rig, and `ready-repair.mjs` is the half that connects to a browser.
 *
 * WHAT BELONGS HERE AND WHAT DOES NOT. This module answers for ONE device: read it, repair it, say
 * what it is. Everything that is about a RUN - the bundle check, the phone revive, the presence
 * read across the fleet, the `problems[]` that refuses a phase - stays in `run.mjs`, because it
 * needs the run's own state to mean anything.
 */
import { GATE_EXPR } from './gate-probe.mjs';
import { OVERLAYS } from './overlay-probe.mjs';

/**
 * Is a client reachable, unlocked, and on a route that can answer that question?
 *
 * `unknown` is a real answer and the honest one: the PIN gate only mounts where the encryption
 * state is needed, so on `/posts` a fully locked client shows no gate at all. Reporting that as
 * "unlocked" is how a drain investigation was once run entirely against a locked phone.
 *
 * `String.raw`, LIKE `GATE_EXPR`, AND FOR THE SAME REASON. This is page source: interpolation does
 * not re-process escapes, so what is written here is what the client parses. The version this
 * replaces was a plain template and needed `\\/login` to emit `\/login` - a double-escaping that
 * broke once already (oxlint caught `/^/login/`, a SyntaxError in the page that `node -c` was happy
 * with). One backslash means one backslash now.
 */
export const READY_EXPR = String.raw`(function () {
  var sidebar = document.querySelectorAll('aside button, nav button').length;
  return JSON.stringify({
    path: location.pathname,
    ready: document.readyState,
    locked: (function () {
      // NO SESSION IS ASKED FIRST, AND IT USED TO BE ASKED SECOND. That order cost the four
      // HEAL-REVOKE rows of 2026-08-28 in one direction and HEAL-NEW-3 in the other, so both halves
      // are written here.
      //
      // A CLIENT WITH NO SESSION IS NOT A PAGE THAT CANNOT BE JUDGED: calling it 'unknown' sent a
      // logged-out W2 from /login to /chat, the app bounced it straight back, and four passes later
      // the phase refused with 'still unknown after 4 repair(s)' - a state no baseline in this rig
      // restored, because launch.mjs no-ops on a running browser and pin.mjs only answers a gate
      // that never mounts.
      //
      // AND A GATE ON /login IS NOT A GATE THAT CAN BE ANSWERED, which is why this now outranks the
      // gate test below. Measured on W1 on 2026-08-28: the PIN dialog was genuinely mounted OVER the
      // login page - '#encryption-pin' present, dialog label 'PIN de chiffrement' - so the gate
      // predicate was RIGHT and the repair it selects is a dead end. pin.mjs typed the correct PIN,
      // clicked Deverrouiller, and the client logged 'refresh latched (cookie already proven dead -
      // not asking again)' and then nothing at all; five passes read LOCKED+overlay and the rung
      // could not start. The repair that works there is login.mjs, and the fresh credential it
      // brings back is also what clears the app's own latch.
      //
      // THE DISCRIMINATOR IS THE PATH, AND IT IS KNOWN BEFORE EITHER QUESTION IS ASKED.
      if (/^\/login/.test(location.pathname) || !!document.querySelector('#username')) return 'signedOut';
      // ONE DEFINITION, shared with pin.mjs, pingate.mjs and state.mjs. The copy this replaces also
      // matched any page whose text merely NAMES the PIN, which /settings does.
      if (${GATE_EXPR}) return 'LOCKED';
      // THE PROOF BELOW ONLY DESCRIBES /chat, SO ONLY /chat MAY BE JUDGED BY IT. This test used to
      // admit /communities as well, on the reasoning that the PIN gate mounts there too - which is
      // true and is already settled one line above, before this ever runs. What it actually did was
      // hand a /communities client to a rendered-proof that page cannot satisfy: its sidebar is
      // links, not buttons, so a fully booted client counts ZERO and was declared 'booting' for
      // ever. Measured 2026-08-15: W1 rendering 7098 characters on the deployed bundle, waiting out
      // four repair passes that had nothing to repair, and taking the whole phase down with it.
      // Answering 'unknown' instead routes it to the repair that already exists and works - send it
      // to /chat - which is where every check puts it anyway.
      if (!/^\/chat/.test(location.pathname)) return 'unknown';
      // NOT SEEING THE GATE IS NOT BEING PAST IT. A booting client shows no gate either -
      // 'readyState' reaches 'complete' while the app is still deciding whether the encryption key
      // is available - so the absence alone reported "unlocked" about a client one second away from
      // raising the prompt. Measured 2026-08-13 on all three clients at once, straight after
      // reload.mjs. Something RENDERED is the proof; until then the honest answer is 'booting'.
      return sidebar > 0 ? 'unlocked' : 'booting';
    })(),
    sidebar: sidebar,
    // A MODAL LEFT OPEN BY THE PREVIOUS CHECK, WHICH NO OTHER PROBE CAN SEE. The client is reachable,
    // unlocked, on /chat and rendering a full sidebar - every existing signal says ready - while an
    // overlay sits on top and swallows the first click the next check makes. Measured 2026-08-14:
    // MSG-5 left the "Ajouter un canal" dialog up and the four scripts after it died inside
    // ensureChat, each reporting a navigation the app was perfectly able to perform. (No backticks
    // in this comment: it lives inside a template literal, and one would end the string here.)
    //
    // ONE DEFINITION, shared with the preconditions in chat.mjs. The private copy this replaces
    // asked only for [role=dialog] / [aria-modal], which is the half of the problem the DESKTOP has:
    // the mobile action sheet carries neither attribute, so a phone left holding one passed this
    // preflight as ready and then ate the next click - the exact failure the field exists to catch,
    // surviving on the one client whose layout renders it.
    overlay: JSON.parse(${OVERLAYS}).length
  });
})()`;

/**
 * Ready is BOTH conditions, and the second one was added after it cost four checks in one run.
 *
 * Being unlocked says the client can answer; carrying no overlay says the next click will reach what
 * it aims at. Neither implies the other, and the state that broke the 2026-08-14 run satisfied every
 * part of the first while failing the second.
 */
export const isReady = (s) => s.locked === 'unlocked' && !s.overlay;

/** How a state reads in a trail - the overlay is part of the state, not a footnote to it. */
export const stateOf = (x) => (x.overlay ? `${x.locked}+overlay` : x.locked);

/**
 * The bound on repair, and why it is a count rather than a clock.
 *
 * EACH REPAIR CAN PRODUCE THE STATE THE OTHER ONE EXISTS TO FIX, so they run in a LOOP rather than
 * once each in a fixed order. Unlocking lands the client wherever it already was - on `/posts` for a
 * freshly launched phone - which is precisely the `unknown` the navigation repairs; running the
 * navigation first and the unlock second therefore refuses a client that was one step from ready.
 * Seen 2026-08-13: A1 launched, gate up, `fix ... unlocking` then `REFUSING TO RUN - still unknown on
 * /posts after repair`, with the phone unlocked and healthy the whole time.
 *
 * Exhausting it reports the TRAIL rather than the last state alone: `LOCKED -> unknown -> LOCKED` is
 * a client re-locking on every navigation, which is a different fault from one that never moves, and
 * the last state cannot tell them apart.
 */
export const MAX_REPAIR_PASSES = 4;
