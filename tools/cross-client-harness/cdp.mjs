#!/usr/bin/env node
/**
 * Dependency-free Chrome DevTools Protocol driver for the cross-client test campaign
 * (docs/wiki/cross-client-testing.md).
 *
 * There is no Playwright or Puppeteer here, and chrome-devtools-mcp bundles its copy where
 * nothing else can require it. Node 24 exposes a global WebSocket, so this is the whole client.
 *
 * ONE driver, ALL THREE clients:
 *   W1  - desktop Chrome, the OWNER account:  --port 9224
 *   W2  - desktop Chrome, the PEER account:   --port 9223
 *   A1  - the Tauri WebView on the phone, the owner's second device, reached through
 *         `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`:  --port 9333
 * W1 was planned on the chrome-devtools MCP; its own Chrome + this driver is strictly better,
 * because a password then never has to appear as a tool-call argument in the transcript.
 *
 * Usage:
 *   node cdp.mjs --port 9223 targets
 *   node cdp.mjs --port 9223 nav https://canari-emse.fr
 *   node cdp.mjs --port 9223 snapshot            # compact list of interactive elements
 *   node cdp.mjs --port 9223 eval "location.href"
 *   node cdp.mjs --port 9223 click "text=Se connecter"
 *   node cdp.mjs --port 9223 fill "input[name=username]" "someone"
 *   node cdp.mjs --port 9223 key Enter
 *   node cdp.mjs --port 9223 wait "text=Conversations" 15000
 *   node cdp.mjs --port 9223 screenshot out.png
 *   node cdp.mjs --port 9223 offline | online
 *
 * Design notes that cost time to learn, keep them:
 * - Svelte does NOT react to `input.value = x`. Every text entry goes through Input.insertText
 *   (trusted, fires beforeinput/input) after a real click to focus. Never assign .value.
 * - Clicks are real Input.dispatchMouseEvent at the element's centre, not element.click(), so
 *   pointer handlers and :active styling behave as they do for a user.
 * - A per-page WebSocket survives same-target navigations, which is all this campaign needs.
 */

/** True only when this file is the process entry point, so it can also be imported as a module. */
const IS_CLI = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

const argv = process.argv.slice(2);
let port = 9223;
let targetIndex = 0;
let targetMatch = null;
// Only when run as a CLI: an importer has its own flags, and parsing theirs would reject them.
while (IS_CLI && argv[0] && argv[0].startsWith('--')) {
  const flag = argv.shift();
  if (flag === '--port') port = Number(argv.shift());
  else if (flag === '--index') targetIndex = Number(argv.shift());
  else if (flag === '--match') targetMatch = argv.shift();
  else throw new Error(`unknown flag ${flag}`);
}
const cmd = IS_CLI ? argv.shift() : null;

/** Page-side selector resolver. `text=` matches visible text, anything else is a CSS selector. */
export const RESOLVE = `(function (sel) {
  if (sel.startsWith('text=')) {
    var needle = sel.slice(5).trim().toLowerCase();
    var all = Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"], [role="link"], [role="menuitem"], input[type="submit"], label, li, summary, span, div, p, h1, h2, h3'));
    var hits = all.filter(function (e) {
      // BOTH, not the first non-empty: a community button's innerText is its avatar initials
      // ("CD") while only its aria-label carries the name, so falling back would never look.
      var t = ((e.innerText || e.value || '') + ' ' + (e.getAttribute('aria-label') || '')).trim().toLowerCase();
      if (!t || t.indexOf(needle) === -1) return false;
      var r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    // INNERMOST wins, and length alone does not decide it. A scroll container holding a single
    // button has exactly the same innerText as the button, so sorting by length leaves the
    // container first (it precedes its child in DOM order) - and its centre is empty space far
    // below the button. Cost a silent no-op click on the channel list. So: drop any hit that
    // contains another hit, then prefer the shortest label among what is left.
    var innermost = hits.filter(function (e) {
      return !hits.some(function (o) { return o !== e && e.contains(o); });
    });

    // VISIBLE TEXT BEATS A LABEL. Sorting by innerText length alone hands victory to whatever has
    // NO innerText at all - and a DM row ships an avatar whose aria-label is "Avatar de <name>"
    // and whose innerText is empty, so the avatar won every time while the row carrying the name
    // lost. Matching on aria-label still has to exist (a community button's innerText is its
    // initials), it just must never outrank an element that visibly says the thing.
    var textual = innermost.filter(function (e) {
      return ((e.innerText || e.value || '').toLowerCase().indexOf(needle) !== -1);
    });
    var pool = textual.length ? textual : innermost;
    pool.sort(function (a, b) { return (a.innerText || '').length - (b.innerText || '').length; });

    // A HIT MUST BE CLICKABLE AT ITS OWN CENTRE. The avatar above resolved to a rect whose centre
    // hit-tested to the "Communautes" nav link, so the click navigated away and the check failed
    // somewhere else entirely, blaming the app. Anything whose centre belongs to another subtree
    // is unusable: reject it here rather than let a caller click into the void. Returning null
    // makes the caller fail loudly, which is the point - a wrong click is worse than no click.
    var clickable = pool.filter(function (e) {
      var r = e.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
        e.scrollIntoView({ block: 'center', inline: 'center' });
        r = e.getBoundingClientRect();
      }
      var at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!at && (at === e || e.contains(at));
    });
    return clickable[0] || null;
  }
  return document.querySelector(sel);
})`;

export async function listTargets(p = port) {
  const res = await fetch(`http://127.0.0.1:${p}/json/list`);
  const all = await res.json();
  return all.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
}

export function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(new Error(`ws error: ${e.message || e.type}`)));
  });
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  // The timer MUST be cleared on the reply, and unref'd besides: an armed 30 s timeout keeps
  // Node's event loop alive, so every command "took" 30 s after its answer had already arrived.
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout on ${method}`));
        }
      }, 30000);
      timer.unref?.();
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ready, send, events, close: () => ws.close() };
}

/** Evaluates an expression in the page and returns its value, awaiting promises. */
export async function evaluate(cx, expression) {
  const r = await cx.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`page exception: ${d.exception?.description || d.text}`);
  }
  return r.result.value;
}


/** Polls a page-side boolean until true. Returns the elapsed ms, or throws on timeout. */
export async function until(cx, predicate, timeoutMs = 20000, stepMs = 60) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(cx, `!!(${predicate})`)) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`until() timed out after ${timeoutMs}ms: ${predicate}`);
}

/** Scrolls the element into view and returns viewport-centre coordinates, or null. */
export async function centreOf(cx, selector) {
  return evaluate(
    cx,
    `(function () {
      var el = ${RESOLVE}(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 80) };
    })()`,
  );
}

/**
 * A centre that is still true when the click lands.
 *
 * ON THE PHONE THE LAYOUT MOVES UNDER THE MEASUREMENT. Focusing the composer opens the soft
 * keyboard, the WebView is resized to the space left, and the send button jumps from y=859 to
 * y=511 - so a rect read a moment earlier aims a tap at empty page. It fails in the worst possible
 * way: the touch is delivered, `document.elementFromPoint` at the OLD spot answers <html>, no
 * click is synthesised, and the draft simply stays in the composer. That is what made MSG-8b read
 * as a lost message (2026-08-06).
 *
 * So: poll until the rect stops moving, then hit-test the integer coordinates that will actually
 * be dispatched. Returns null when the element cannot be pinned down, which the caller must treat
 * as a failure rather than clicking anyway.
 */
export async function stableCentreOf(cx, selector, timeoutMs = 4000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const p = await centreOf(cx, selector);
    if (!p) {
      last = null;
      await new Promise((r) => setTimeout(r, 120));
      continue;
    }
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (last && last.x === x && last.y === y) {
      const ok = await evaluate(
        cx,
        `(function () {
          var el = ${RESOLVE}(${JSON.stringify(selector)});
          var hit = document.elementFromPoint(${x}, ${y});
          return !!el && !!hit && (hit === el || el.contains(hit));
        })()`
      );
      if (ok) return { ...p, x, y };
    }
    last = { x, y };
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

/**
 * Dispatches ONE recorded click at a point, with the input modality the target actually listens to.
 *
 * THE TRAP, paid for on A1: mobile Chrome does NOT activate a button from
 * Input.dispatchMouseEvent - it wants touch. The failure is silent and looks like a rejected
 * form: the page never submits, and a hidden Material validation string ("Vous devez entrer
 * votre identifiant") is already in innerText, so a text dump reads exactly like a real error.
 * Desktop Chrome has maxTouchPoints === 0, the phone's WebView and Chrome do not.
 *
 * THIS IS A POINT-TAKING PRIMITIVE BECAUSE THE POINT IS THE ONLY PART THAT VARIES. A selector is
 * one way to find a point; a hovered action row inside a message bubble is another, and it cannot
 * be expressed as a selector at all. When `clickBubbleAction` computed its own coordinates it also
 * grew its own dispatch - and inherited NONE of what the lines below cost to learn: no recorder, no
 * pointer move, no parking. It clicked blind for as long as it existed. Everything that clicks goes
 * through here, and a new caller supplies a point and nothing else.
 *
 * @returns {{modality: 'touch'|'mouse', received: object|null}} `received` NAMES what took the
 *   click - the caller asserts on it, and `null` is not by itself a failure (see `lastClick`).
 */
export async function clickAtPoint(cx, x, y, { park = true } = {}) {
  const touch = await evaluate(cx, 'navigator.maxTouchPoints > 0');
  await armClickRecorder(cx);

  if (touch) {
    const point = [{ x, y, radiusX: 12, radiusY: 12, force: 1 }];
    await cx.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point });
    await cx.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    // Move first. Chrome tracks a pointer position per target, and a press arriving at coordinates
    // the pointer has never occupied leaves the element un-hovered; components that open on
    // pointerdown after a hover-driven state change then never fire. Cheap, and it removes a whole
    // class of false failures.
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
    // PARK THE POINTER AFTERWARDS. A synthetic pointer never leaves where it was put, so anything
    // that opens on hover stays open for the rest of the session: the collapsed nav rail expanded
    // over the conversation list and every later hit-test returned the NAV, which read exactly like
    // a layout bug in the app. Clicking is an event, not a resting state - so return the pointer to
    // neutral ground. Pass { park: false } where sustained hover is the thing under test.
    if (park) {
      const rest = await evaluate(cx, `JSON.stringify({ x: innerWidth - 3, y: Math.round(innerHeight / 2) })`);
      const { x: rx, y: ry } = JSON.parse(rest);
      await cx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rx, y: ry, buttons: 0 });
    }
  }
  return { modality: touch ? 'touch' : 'mouse', received: await lastClick(cx) };
}

/**
 * Clicks the element a selector names, at a centre that is still true when the click lands.
 */
export async function realClick(cx, selector, { park = true } = {}) {
  const p = await stableCentreOf(cx, selector);
  if (!p) throw new Error(`no stable element for selector: ${selector}`);
  return { ...p, ...(await clickAtPoint(cx, p.x, p.y, { park })) };
}

/**
 * Arms a page-side recorder for the NEXT click, naming whatever actually receives it.
 *
 * A HIT TEST BEFORE THE DISPATCH AND A SCREEN READ AFTER IT BOTH DESCRIBE A MOMENT THE CLICK DID
 * NOT HAPPEN. `stableCentreOf` proves the point belonged to the element 120 ms earlier; the screen
 * afterwards shows what the page became. Neither can tell a click that landed on the wrong element
 * apart from a right element that did nothing - and on 2026-08-14 that gap cost two diagnoses:
 * openChannel reported the create-channel modal covering coordinates its own hit test had just
 * cleared, and nothing in the run could say whether the click opened that modal or merely found it.
 * The event is the only witness, so listen for it - in the CAPTURE phase, which no page handler can
 * pre-empt or stop.
 */
export async function armClickRecorder(cx) {
  await evaluate(
    cx,
    `(function () {
      window.__lastClick = null;
      if (window.__clickRec) document.removeEventListener('click', window.__clickRec, true);
      window.__clickRec = function (e) {
        var t = e.target;
        // THE TARGET IS USUALLY NOT THE CONTROL. A click on a button lands on the span or the
        // svg inside it, so tag/label/text describe a decoration and answer nothing about WHICH
        // control took the event - the only question this recorder exists to answer. The enclosing
        // button's accessible name is that answer, and a caller can assert on it.
        var b = t.closest ? t.closest('button') : null;
        window.__lastClick = {
          x: e.clientX,
          y: e.clientY,
          tag: t.tagName,
          label: t.getAttribute('aria-label') || '',
          text: (t.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40),
          btn: b ? (b.getAttribute('aria-label') || b.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40) : ''
        };
      };
      document.addEventListener('click', window.__clickRec, true);
      return true;
    })()`
  );
}

/**
 * Reads the armed recorder. `null` means no click was observed, which is NOT a failure by itself:
 * a touch dispatch synthesises its click asynchronously, and a click that navigates can tear the
 * context down before the read. Callers assert on a NAMED target, never on the absence of one.
 */
export async function lastClick(cx, timeoutMs = 500) {
  const t0 = Date.now();
  for (;;) {
    const seen = await evaluate(cx, `JSON.stringify(window.__lastClick || null)`).catch(() => null);
    const parsed = seen ? JSON.parse(seen) : null;
    if (parsed || Date.now() - t0 >= timeoutMs) return parsed;
    await new Promise((r) => setTimeout(r, 40));
  }
}


/**
 * Activates an element directly (`el.click()`), bypassing coordinates entirely.
 *
 * WHY THIS EXISTS. Synthetic Input.dispatchMouseEvent / dispatchTouchEvent reach the right
 * element - elementFromPoint confirms it - yet some buttons never fire their handler (proven on
 * the community "Rejoindre" button and the mobile "Deverrouiller"). For a TEST harness that is
 * poison: the click silently does nothing and the check reports a false failure.
 *
 * So the rule is explicit rather than magic: use realClick where the INPUT PATH is what is under
 * test, and activate() for plumbing - dialogs, navigation, unlocking - where only the effect
 * matters. Never a silent fallback between the two.
 */
export async function activate(cx, selector) {
  const res = await evaluate(
    cx,
    `(function () {
      var el = ${RESOLVE}(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return (el.innerText || el.value || el.tagName).trim().slice(0, 60);
    })()`,
  );
  if (res === null) throw new Error(`no element to activate: ${selector}`);
  return res;
}

export async function pressKey(cx, key) {
  const map = {
    Enter: { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' },
    Tab: { windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' },
    Escape: { windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' },
    Backspace: { windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' },
    ArrowDown: { windowsVirtualKeyCode: 40, key: 'ArrowDown', code: 'ArrowDown' },
    ArrowUp: { windowsVirtualKeyCode: 38, key: 'ArrowUp', code: 'ArrowUp' },
  };
  const k = map[key];
  if (!k) throw new Error(`unmapped key ${key}`);
  await cx.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
  await cx.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}

/** Compact inventory of what a user could act on - the text substitute for a screenshot. */
export const SNAPSHOT = `(function () {
  function vis(e) { var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function label(e) {
    return (e.getAttribute('aria-label') || e.placeholder || e.value || e.innerText || '')
      .replace(/\\s+/g, ' ').trim().slice(0, 90);
  }
  var out = { url: location.href, title: document.title, interactive: [], headings: [] };
  document.querySelectorAll('h1, h2, h3, [role="heading"]').forEach(function (e) {
    if (vis(e)) out.headings.push(label(e));
  });
  document.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="tab"], [role="menuitem"], [contenteditable="true"]').forEach(function (e) {
    if (!vis(e)) return;
    out.interactive.push({
      tag: e.tagName.toLowerCase(),
      type: e.type || undefined,
      id: e.id || undefined,
      name: e.name || undefined,
      cls: (e.className && typeof e.className === 'string' ? e.className.split(' ').slice(0, 3).join('.') : undefined),
      text: label(e),
      disabled: e.disabled || undefined,
    });
  });
  return out;
})()`;

async function main() {
  const targets = await listTargets();
  if (!targets.length) throw new Error(`no page target on port ${port}`);
  if (cmd === 'targets') {
    targets.forEach((t, i) => console.log(`[${i}] ${t.title} :: ${t.url}`));
    return;
  }
  const target = targetMatch
    ? targets.find((t) => t.url.includes(targetMatch) || t.title.includes(targetMatch))
    : targets[targetIndex];
  if (!target) throw new Error(`no target matching ${targetMatch ?? targetIndex}`);

  const cx = connect(target.webSocketDebuggerUrl);
  await cx.ready;
  await cx.send('Runtime.enable');
  if (['nav', 'reload', 'screenshot'].includes(cmd)) await cx.send('Page.enable');

  const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

  switch (cmd) {
    case 'nav': {
      await cx.send('Page.navigate', { url: argv[0] });
      const ms = await until(cx, `document.readyState === 'complete' && location.href.indexOf('${argv[0]}') === 0`);
      out({ url: await evaluate(cx, 'location.href'), ms });
      break;
    }
    case 'reload': {
      await cx.send('Page.reload', { ignoreCache: argv[0] === 'hard' });
      
      const ms = await until(cx, `document.readyState === 'complete'`);
      out({ url: await evaluate(cx, 'location.href'), ms });
      break;
    }
    case 'eval':
      out(await evaluate(cx, argv[0]));
      break;
    case 'snapshot':
      out(await evaluate(cx, SNAPSHOT));
      break;
    case 'click':
      out(await realClick(cx, argv[0]));
      break;
    case 'fill': {
      await realClick(cx, argv[0]);
      await evaluate(
        cx,
        `(function () { var el = ${RESOLVE}(${JSON.stringify(argv[0])}); if (el && 'value' in el && el.value) { el.select ? el.select() : null; } })()`,
      );
      await cx.send('Input.insertText', { text: argv[1] });
      out({ filled: argv[0], length: argv[1].length });
      break;
    }
    case 'insert':
      await cx.send('Input.insertText', { text: argv[0] });
      out({ inserted: argv[0].length });
      break;
    case 'key':
      await pressKey(cx, argv[0]);
      out({ key: argv[0] });
      break;
    case 'wait': {
      const deadline = Date.now() + (Number(argv[1]) || 15000);
      let found = null;
      while (Date.now() < deadline) {
        found = await centreOf(cx, argv[0]);
        if (found) break;
        await new Promise((r) => setTimeout(r, 60));
      }
      if (!found) throw new Error(`timeout waiting for ${argv[0]}`);
      out(found);
      break;
    }
    case 'screenshot': {
      const shot = await cx.send('Page.captureScreenshot', { format: 'png' });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(argv[0], Buffer.from(shot.data, 'base64'));
      out({ saved: argv[0] });
      break;
    }
    case 'offline':
      await cx.send('Network.enable');
      await cx.send('Network.emulateNetworkConditions', {
        offline: true,
        latency: 0,
        downloadThroughput: 0,
        uploadThroughput: 0,
      });
      out({ offline: true });
      break;
    case 'online':
      await cx.send('Network.enable');
      await cx.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      out({ offline: false });
      break;
    default:
      throw new Error(`unknown command ${cmd}`);
  }
  cx.close();
}

if (IS_CLI && cmd) {
  main().catch((e) => {
    console.error(`[cdp:${port}] ${e.message}`);
    process.exit(1);
  });
}
