/**
 * Chat primitives shared by every check in the campaign.
 *
 * Deliberately a MODULE, not a CLI: each check composes send/read/reconcile differently, and the
 * one thing they must all share is the definition of "a message arrived" - otherwise two checks
 * disagree about a pass for reasons that belong to the harness rather than to the app.
 *
 * See docs/wiki/cross-client-testing.md section 9 (evidence rule).
 */
import { RESOLVE, activate, connect, evaluate, listTargets, realClick, until } from './cdp.mjs';

// SCOPED TO THE CHAT, and that scoping is the whole point.
//
// `.chat-composer-editor` is a class of the SHARED `MentionComposerInput`, which the social feed
// also uses for its "Ajouter un commentaire..." boxes. So a bare `.chat-composer-editor` is present
// on `/posts` too, and every "am I in a conversation?" post-condition built on it answered YES on
// the FEED - which is exactly the fiction the post-conditions exist to prevent (NOTIF-7 killed
// reported `composer: true` while the app was sitting on the social feed). `send()` is worse: on
// the feed it would have typed the marker into a COMMENT box on somebody's post.
//
// `.chat-composer-footer` belongs to `ChatComposer.svelte` alone.
export const COMPOSER = '.chat-composer-footer .chat-composer-editor';

/** True once the send control exists and is no longer disabled - see the race in `send`. */
export const SEND_ENABLED = `(function () {
  var b = [...document.querySelectorAll('button')].find(function (e) {
    return (e.getAttribute('aria-label') || '').includes('Envoyer le message');
  });
  return !!b && !b.disabled;
})()`;

/**
 * The open conversation's pane, as page-side JS.
 *
 * Counting on `document.body` double-counts EVERY message: the sidebar renders the last one as a
 * preview, so a single delivered message reads as two copies and the duplicate assertion - the
 * whole point of MSG-1 - is meaningless. The pane is the composer's nearest <section>; the sidebar
 * is a sibling of it.
 */
export const PANE = `(document.querySelector('${'.chat-composer-footer .chat-composer-editor'}') || {}).closest ? document.querySelector('.chat-composer-footer .chat-composer-editor').closest('section') : null`;

/**
 * The pane's text WITHOUT the composer's - the composer is inside the pane.
 *
 * Without the subtraction, text sitting in the composer reads back as a delivered message: a send
 * that failed to submit still "arrives", `awaitMessage` returns instantly on the sender, and a
 * triage says the sender has its message when what it actually has is an unsent draft. That is
 * exactly how MSG-8b first read as an app-level loss (2026-08-06). The composer's own text is
 * removed by string, not by DOM surgery, so `innerText` keeps its visible-only semantics - which
 * the virtualised-list reconciliation depends on.
 */
const PANE_TEXT = `(function () {
  var c = document.querySelector('.chat-composer-footer .chat-composer-editor');
  var pane = c ? c.closest('section') : null;
  if (!pane) return '';
  var text = pane.innerText;
  var draft = (c.innerText || '').trim();
  return draft ? text.split(draft).join('') : text;
})()`;

/**
 * Connect to a client by port, optionally picking the tab whose URL contains `match`.
 *
 * FOCUS EMULATION IS ON BY DEFAULT, and it is not a convenience.
 *
 * Only one OS window can hold the focus, and this harness drives THREE clients plus a terminal - so
 * at least two of them always report `document.hasFocus() === false`, which is a lie about what a
 * real user's window is doing. Two product paths read exactly that bit:
 * `MainChatPage.svelte:435` refuses to emit a read receipt unless the window is focused AND the tab
 * visible, and `useMessaging.svelte.ts:376` fires the web system notification only when it is not.
 * NOTIF-4 therefore FAILED twice (2026-08-06, 22:21 and 22:34) with `dismissedInMs: null` for a
 * reason that belonged entirely to the harness: W1 read the message, never sent the receipt, so the
 * phone was never told to cancel its notification. Harness fault #18.
 *
 * `Emulation.setFocusEmulationEnabled` makes the page report focused and active without giving it
 * the real OS focus, so all three clients can be "the focused window" at once. It does NOT touch
 * `document.visibilityState`, which is what the TAB phase manipulates - backgrounding a tab by
 * focusing a SIBLING TAB still works, and those checks keep their meaning.
 *
 * Pass `{ focus: false }` where the unfocused state is the thing under test.
 */
export async function client(port, match = null, { focus = true } = {}) {
  const targets = await listTargets(port);
  const t = match ? targets.find((x) => x.url.includes(match)) : targets[0];
  if (!t) throw new Error(`no target on ${port} matching ${match}; have ${targets.map((x) => x.url).join(' | ')}`);
  const cx = connect(t.webSocketDebuggerUrl);
  await cx.ready;
  await cx.send('Runtime.enable');
  cx.port = port;
  if (focus) {
    // Not supported by the Tauri WebView on some builds; a check must not die because of it, but a
    // silent failure would put the campaign right back where fault #18 left it, so it is recorded.
    cx.focusEmulated = await cx
      .send('Emulation.setFocusEmulationEnabled', { enabled: true })
      .then(() => true, () => false);
  }
  return cx;
}

/**
 * Navigate to a top-level app section. The app is a SPA whose conversations are NOT routes
 * (see DURABLE RULES: `/c/<groupId>` is not a route), so section navigation is by URL but
 * conversation selection is by click.
 *
 * DO NOT USE ON A1. A reload of the Tauri webview re-locks the encryption PIN, so the check then
 * waits on a modal it never expected; the run does not fail, it HANGS, and prints nothing. Use
 * `ensureChat` there - which is also the more faithful path, since a real user clicks.
 */
export async function goto(cx, path) {
  await cx.send('Page.navigate', { url: `${await origin(cx)}${path}` });
  await until(cx, `document.readyState === 'complete'`, 20000);
}

export const origin = (cx) => evaluate(cx, 'location.origin');

/** Click the sidebar/list entry whose visible text contains `name`, and wait for the composer. */
/**
 * Puts the client on the Discussions list, by the in-app link when it is elsewhere.
 *
 * Checks must not start by reloading: a full load warms caches and finishes bootstraps that a real
 * user's click does not, and that difference is itself a bug this campaign has already found once.
 */
export async function ensureChat(cx) {
  if ((await evaluate(cx, 'location.pathname')) === '/chat') return 'already';
  await realClick(cx, 'text=Discussions');
  await until(cx, `location.pathname === '/chat'`, 15000);
  return 'navigated';
}

/**
 * Opens a DM by peer name, from a full load of `/chat`.
 *
 * The full load is not laziness: on the build under test the DM rows show "Utilisateur inconnu"
 * after any client-side navigation (fixed in ace0596a, not yet deployed), so there is no name to
 * click. Only a load resolves them. Checks that care about the navigation itself must not use this.
 */
export async function openDM(cx, name) {
  await goto(cx, '/chat');
  return openConversation(cx, name);
}

/** Opens the campaign's channel: community "Campagne de test", channel `general`. */
export async function openChannel(cx, community = 'Campagne de test', channel = 'general') {
  await goto(cx, '/communities');
  await until(cx, `!!${RESOLVE}('text=${community}')`, 20000);
  await realClick(cx, `text=${community}`);
  await until(cx, `!!${RESOLVE}('text=${channel}')`, 15000);
  await realClick(cx, `text=${channel}`);
  await until(cx, `!!document.querySelector('${'.chat-composer-footer .chat-composer-editor'}')`, 15000);
  return `${community}/${channel}`;
}

export async function openConversation(cx, name) {
  // The list is fetched, so it is EMPTY for the first few hundred ms after a navigation. Failing
  // on the first look would make every check that navigates flaky for a reason that is the
  // harness's, not the app's.
  const find = `(function () {
      var wanted = ${JSON.stringify(name)}.toLowerCase();
      var els = [].slice.call(document.querySelectorAll('button, [role=button], a, li'));
      var best = els.filter(function (e) {
        var t = (e.innerText || '').trim();
        return t && t.toLowerCase().indexOf(wanted) !== -1 && e.getBoundingClientRect().width > 0;
      });
      best.sort(function (a, b) { return a.innerText.length - b.innerText.length; });
      if (!best.length) return null;
      best[0].scrollIntoView({ block: 'center' });
      return best[0].innerText.trim().slice(0, 60);
    })()`;
  await until(cx, `${find} !== null`, 20000);
  const hit = await evaluate(cx, find);
  if (!hit) throw new Error(`no conversation entry matching ${name}`);
  await realClick(cx, `text=${hit.split('\n')[0]}`);
  await until(cx, `!!document.querySelector('${COMPOSER}')`, 15000);
  return hit;
}

/**
 * The campaign markers currently rendered, in DOM order.
 *
 * There is NO `data-message-id` in the rendered DOM, so a message cannot be identified by an
 * attribute. Every check therefore stamps its own unique marker into the text it sends, and
 * ordering, gaps and duplicates are all read back from that - which has the side benefit of
 * proving the text actually decrypted, not merely that a row appeared.
 */
export async function markers(cx, prefix) {
  const raw = await evaluate(
    cx,
    `JSON.stringify((${PANE_TEXT}.match(new RegExp(${JSON.stringify(prefix)} + '-[0-9a-z]+', 'g')) || []))`,
  );
  return JSON.parse(raw);
}

/** Wait until a message whose text contains `marker` is rendered; returns the elapsed ms. */
export function awaitMessage(cx, marker, timeoutMs = 20000) {
  return until(cx, `${PANE_TEXT}.indexOf(${JSON.stringify(marker)}) !== -1`, timeoutMs, 50);
}

/** How many times `marker` appears in the open conversation - the duplicate check. */
export function countMessage(cx, marker) {
  return evaluate(cx, `${PANE_TEXT}.split(${JSON.stringify(marker)}).length - 1`);
}

/**
 * Type into the composer and send.
 *
 * The composer is a contenteditable (`mention-composer-editor`), so the value cannot be assigned:
 * Svelte never sees it. Focus with a real click, then Input.insertText, then activate the send
 * button. Returns the client-side timestamp of the send.
 */
export async function send(cx, text) {
  await realClick(cx, COMPOSER);
  await evaluate(cx, `document.querySelector('${COMPOSER}').focus()`);
  await cx.send('Input.insertText', { text });
  const typed = await evaluate(cx, `document.querySelector('${COMPOSER}').innerText.trim()`);
  if (!typed.includes(text.slice(0, 20))) throw new Error(`composer did not take the text (has ${JSON.stringify(typed)})`);
  // The send button is DISABLED while the composer is empty and Svelte re-enables it a tick after
  // the input event, so clicking straight after `Input.insertText` lands on a disabled control and
  // is discarded in silence. On the desktop clients the extra CDP round trips hid the race; on the
  // phone's WebView it lost MSG-8b outright and the draft stayed in the box. Wait for the state,
  // never for a delay.
  await until(cx, SEND_ENABLED, 5000, 50);

  // ACTIVATE, NOT TAP, and only because coordinates are unusable here - see the rule in
  // `activate`. Focusing the composer opens the soft keyboard, which on Android shrinks the VISUAL
  // viewport (914 -> 572) while the LAYOUT viewport stays 914. The composer bar is pinned above
  // the keyboard, so `getBoundingClientRect` reports the send button at y=511 - correct for the
  // page - while `Input.dispatchTouchEvent` addresses the layout viewport, and the tap lands on
  // <html>. Measured 2026-08-06: coordinates re-read and stable, hit-test clean, touchstart and
  // touchend delivered, target <html>, no click, draft still in the box. `.click()` sends every
  // time. The app is not at fault and the mobile tap path is verified separately, on device.
  const at = Date.now();
  await activate(cx, 'text=Envoyer le message');

  // POST-CONDITION, not a nicety: the click can land and the composer keep its text - on MSG-8b
  // the phone's send button did nothing, the draft stayed put, and the check read the DRAFT as a
  // delivered message and reported an app-level loss. An action that cannot prove it happened
  // must fail here, where the cause is still on screen, not three assertions later.
  const emptied = await until(cx, `!document.querySelector('${COMPOSER}').innerText.trim()`, 5000, 100).catch(
    () => null
  );
  if (emptied === null) {
    const left = await evaluate(cx, `document.querySelector('${COMPOSER}').innerText.trim()`);
    throw new Error(`send did not submit - composer still holds ${JSON.stringify(left.slice(0, 80))}`);
  }
  return at;
}

/** Message bubbles are `<p>` leaves inside the pane; this is their viewport centre. */
export async function bubbleCentre(cx, textMatch) {
  const p = await evaluate(
    cx,
    `JSON.stringify((function () {
      var pane = document.querySelector('${'.chat-composer-footer .chat-composer-editor'}').closest('section');
      var hits = [].filter.call(pane.querySelectorAll('p'), function (e) {
        return (e.textContent || '').indexOf(${JSON.stringify(textMatch)}) !== -1;
      });
      if (!hits.length) return null;
      var el = hits[hits.length - 1];
      el.scrollIntoView({ block: 'center' });
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: el.textContent.slice(0, 50) };
    })())`,
  );
  if (!p || p === 'null') throw new Error(`no bubble matching ${textMatch}`);
  return JSON.parse(p);
}

/** Hovers a bubble so its action row appears, and returns what became clickable. */
export async function hoverBubble(cx, textMatch) {
  const c = await bubbleCentre(cx, textMatch);
  await cx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y, buttons: 0 });
  await new Promise((r) => setTimeout(r, 400));
  return c;
}

/**
 * Clicks an action (Répondre, Transférer, Supprimer...) ON A GIVEN MESSAGE.
 *
 * NEVER use a bare `text=Répondre` for this. Every message row carries the whole action row in the
 * DOM, hidden until hover, so a document-wide selector resolves to the FIRST one - it silently
 * replies to the oldest message in the history and the check still looks like it worked. Found
 * exactly that way on the first run of MSG-3. The button must be searched inside the bubble's own
 * row, and the row is the nearest ancestor that actually contains one.
 */
export async function clickBubbleAction(cx, textMatch, label) {
  await hoverBubble(cx, textMatch);
  const point = await evaluate(
    cx,
    `JSON.stringify((function () {
      var pane = document.querySelector('${'.chat-composer-footer .chat-composer-editor'}').closest('section');
      var hits = [].filter.call(pane.querySelectorAll('p'), function (e) {
        return (e.textContent || '').indexOf(${JSON.stringify(textMatch)}) !== -1;
      });
      if (!hits.length) return null;
      var node = hits[hits.length - 1];
      for (var i = 0; i < 8 && node.parentElement; i++) {
        node = node.parentElement;
        var btn = [].filter.call(node.querySelectorAll('button'), function (b) {
          return (b.getAttribute('aria-label') || b.innerText || '').trim().indexOf(${JSON.stringify(label)}) === 0;
        })[0];
        if (btn) {
          var r = btn.getBoundingClientRect();
          if (r.width === 0) return { blocked: 'action button has no box - not hovered?' };
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: (btn.getAttribute('aria-label') || btn.innerText).trim() };
        }
      }
      return null;
    })())`,
  );
  if (!point || point === 'null') throw new Error(`no "${label}" action on the row of ${textMatch}`);
  const p = JSON.parse(point);
  if (p.blocked) throw new Error(p.blocked);
  await cx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cx.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  }
  return p;
}

/**
 * Stages a real file on the composer's hidden `<input type=file>`, over the DOM domain.
 *
 * The picker is an OS dialog no driver can answer, so the file is handed straight to the input -
 * which is also what the browser does after a pick, so the app's own code path is unchanged. The
 * input is `hidden` and `offsetParent === null`; that is irrelevant to `DOM.setFileInputFiles`,
 * and deliberately NOT worked around by clicking "Joindre un fichier" first, which would open the
 * dialog and hang the run.
 *
 * @param {string[]} files absolute paths
 */
export async function attachFiles(cx, files) {
  await cx.send('DOM.enable');
  const { root } = await cx.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cx.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: 'input[type=file]',
  });
  if (!nodeId) throw new Error('no file input in the composer');
  await cx.send('DOM.setFileInputFiles', { nodeId, files });
  return files.length;
}

export { activate, evaluate, realClick, until };
