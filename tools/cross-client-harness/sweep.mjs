/**
 * THE GRAPHICAL PASS, ON A CLIENT THAT IS ACTUALLY RENDERING - every route, one instrument.
 *
 *   bun sweep.mjs                    # A1, at whatever width the device is currently at
 *   bun sweep.mjs --device W1        # the same sweep in a desktop browser
 *   bun sweep.mjs --route /calendar  # one route, repeatable while fixing it
 *
 * ## Why this is a script and not a paragraph
 *
 * The 2026-09-14 route sweep was run by hand, in Chrome, with a device-metrics override, and it
 * found four truncation defects. Its own conclusion was that **what it could not reach is REAL
 * HARDWARE** - and a sweep that has to be retyped from a chat history to be repeated is a sweep
 * nobody repeats. Three of three iOS defects were invisible to every gate in this repository, so
 * the instrument that answers "does this page fit" has to be runnable against a phone, not only
 * against a browser pretending to be one.
 *
 * ## What it measures, and why each number is here
 *
 * Two questions, and they are NOT the same question:
 *
 * 1. **Does the page overflow sideways?** `documentElement.scrollWidth - clientWidth`. A page that
 *    scrolls horizontally is broken on a phone whatever else is true of it.
 * 2. **Does anything stick out past the viewport?** An element can exceed the viewport while the
 *    document does not scroll, because an ancestor clips it - the user simply never sees the end of
 *    it. That is the shape three of the four 2026-09-14 defects had.
 *
 * And one more that is a SUSPICION rather than a defect: **text that is being clipped by its own
 * box** (`scrollWidth > clientWidth` on an element whose overflow is hidden). Truncation is often
 * correct - a conversation title in a narrow bar is meant to end in an ellipsis. So these are
 * reported, never failed on: the rule the user gave is that something truncated *in normal use*
 * means the layout should be revisited, and only a reader can say which is which.
 *
 * ## How a route is reached, and why it is not `Page.navigate`
 *
 * By injecting an anchor and clicking it, which is what a user does and what the router is written
 * for. A hard navigation per route would re-boot the WASM MLS client fifty times, turning a
 * two-minute sweep into a twenty-minute one and measuring a first paint rather than a page. A route
 * that cannot be reached by a link is reported as UNREACHED - that is a finding, not a reason to
 * fall back to a hard load.
 */
import { connect, evaluate, listTargets } from './cdp.mjs';
import { PORTS } from './names.mjs';

/**
 * Every route the app has, derived from `frontend/src/routes` and filtered to the ones a sweep can
 * open without inventing an id. The dynamic ones are reached through a real row where one exists.
 *
 * `/auth/callback`, `/c/join/[token]` and `/g/join/[token]` are deliberately absent: each consumes
 * a single-use credential, so opening one is a side effect rather than a measurement.
 */
const ROUTES = [
  '/',
  '/posts',
  '/associations',
  '/associations/new',
  '/calendar',
  '/calendar/export',
  '/chat',
  '/communities',
  '/dashboard',
  '/directory',
  '/documents',
  '/events',
  '/forms',
  '/forms/create',
  '/lists',
  '/lists/new',
  '/notifications',
  '/profile',
  '/settings',
  '/shop',
  '/account/purchases',
  '/legal/cgu',
  '/legal/privacy',
  '/legal/child-safety',
  '/admin',
  '/admin/agenda',
  '/admin/associations',
  '/admin/carte',
  '/admin/cercle',
  '/admin/document-reviewers',
  '/admin/legacy-cotisations',
  '/admin/moderation',
  '/admin/platform',
  '/admin/status',
  '/admin/storage',
  '/admin/users',
];

/**
 * The probe, as a string because it is evaluated in the page.
 *
 * It reports the CLASS of an offending element rather than a selector path: a Tailwind class list is
 * what a fix edits, and a path through six anonymous divs is not.
 */
const PROBE = `(function () {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const overflow = de.scrollWidth - vw;
  const over = [];
  const clipped = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      over.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute('class') || '-').slice(0, 70),
        left: Math.round(r.left),
        right: Math.round(r.right),
        text: (el.textContent || '').trim().slice(0, 40),
      });
    }
    // Text clipped by its own box: only leaves, and only where the overflow is actually hidden.
    if (el.children.length === 0 && el.scrollWidth > el.clientWidth + 1) {
      if (cs.overflowX === 'hidden' || cs.textOverflow === 'ellipsis') {
        clipped.push({
          cls: (el.getAttribute('class') || '-').slice(0, 70),
          text: (el.textContent || '').trim().slice(0, 60),
          shown: el.clientWidth,
          needed: el.scrollWidth,
        });
      }
    }
  }
  return JSON.stringify({
    path: location.pathname,
    vw,
    overflow,
    // The deepest offender is the one worth naming: an ancestor is over-wide because its child is.
    over: over.slice(-6),
    overCount: over.length,
    clipped: clipped.slice(0, 8),
    clippedCount: clipped.length,
  });
})()`;

/** Injects an anchor for `route`, clicks it, and returns once the router has actually moved. */
async function goto(cx, route) {
  await evaluate(
    cx,
    // ONE anchor, reused, and never removed. Removing it after the click is what turned a
    // client-side navigation into a native one: the router reads the anchor from the event in a
    // continuation, so an element detached in the same tick is no longer the link it was handed -
    // it falls through to a real navigation, which in a Tauri shell tears the app down rather than
    // loading a page. The element is parked off-screen instead, where it costs nothing.
    `(function () {
      let a = document.getElementById('__sweep_link');
      if (!a) {
        a = document.createElement('a');
        a.id = '__sweep_link';
        a.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(a);
      }
      a.href = ${JSON.stringify(route)};
      // Deferred on purpose: were the click to become a real navigation, it would destroy this
      // execution context, and an evaluate whose context dies never answers - it times out. Firing
      // on the next tick lets this call return first, whatever the click turns into.
      setTimeout(() => a.click(), 0);
      return true;
    })()`
  );
  // Let the click land and the router swap before asking anything. Reading `location` 300 ms into a
  // navigation asks a context that is being replaced, and that call does not answer - it times out,
  // which reads like a dead app rather than a busy one.
  await new Promise((r) => setTimeout(r, 1200));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const here = await evaluate(cx, 'location.pathname');
    if (here === route || (route === '/' && here === '/')) {
      // The router has moved; give the page its data before measuring a skeleton.
      await new Promise((r) => setTimeout(r, 1400));
      return true;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const device = (args[args.indexOf('--device') + 1] || 'A1').toUpperCase();
  const only = args.includes('--route') ? args[args.indexOf('--route') + 1] : null;
  const port = PORTS[device];
  if (!port) throw new Error(`unknown device ${device} - known: ${Object.keys(PORTS).join(', ')}`);

  const targets = await listTargets(port);
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!page) throw new Error(`no page target on ${device} (port ${port}) - is the app open?`);

  const cx = connect(page.webSocketDebuggerUrl);
  await cx.ready;

  const vw = await evaluate(cx, 'document.documentElement.clientWidth');
  const dpr = await evaluate(cx, 'window.devicePixelRatio');
  console.log(`[sweep] ${device} at ${vw} CSS px (dpr ${dpr})`);

  const routes = only ? [only] : ROUTES;
  const findings = [];
  for (const route of routes) {
    const reached = await goto(cx, route);
    if (!reached) {
      const at = await evaluate(cx, 'location.pathname');
      console.log(`  ${route.padEnd(30)} UNREACHED (stayed on ${at})`);
      findings.push({ route, unreached: true, at });
      continue;
    }
    const raw = await evaluate(cx, PROBE);
    const r = JSON.parse(raw);
    const bad = r.overflow > 0 || r.overCount > 0;
    const mark = bad ? 'OVER' : '    ';
    console.log(
      `  ${route.padEnd(30)} ${mark} scroll=${r.overflow} over=${r.overCount} clipped=${r.clippedCount}`
    );
    if (bad) {
      for (const o of r.over) {
        console.log(`        ${o.tag} [${o.left}..${o.right}] ${o.cls}  "${o.text}"`);
      }
    }
    findings.push({ route, ...r });
  }

  const over = findings.filter((f) => f.overflow > 0 || f.overCount > 0);
  const unreached = findings.filter((f) => f.unreached);
  console.log(
    `\n[sweep] ${findings.length} route(s) at ${vw}px: ${over.length} overflowing, ${unreached.length} unreached`
  );
  // The clipped list is a READING, not a verdict - printed last so it is not mistaken for failures.
  const clipping = findings.filter((f) => f.clippedCount > 0);
  if (clipping.length) {
    console.log(`\n[sweep] text clipped by its own box - judge each, do not assume a defect:`);
    for (const f of clipping) {
      for (const c of f.clipped) {
        console.log(`  ${f.route.padEnd(24)} ${c.shown}/${c.needed}px  "${c.text}"`);
      }
    }
  }
  cx.close();
  process.exit(over.length ? 1 : 0);
}

await main();
