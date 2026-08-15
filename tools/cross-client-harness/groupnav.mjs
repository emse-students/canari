/**
 * Opening a GROUP conversation by name, and proving the right one opened.
 *
 * `openConversation` in `chat.mjs` cannot do this, and the reason is a harness fault found by
 * HEAL-W2's first run. It selects the shortest element whose text contains the name - correct - and
 * then clicks `text=<first LINE of that element>`. The first line of a group row is the one-letter
 * AVATAR, so asking for `HGRPktp5w` clicks `text=H`, which matches EVERY group whose name starts
 * with H. The run opened a different group and would have measured it, silently.
 *
 * One module rather than a copy in each check, because the failure it prevents is precisely two
 * call sites disagreeing about which conversation is on screen.
 */
import { evaluate, goto, until } from './chat.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COMPOSER = '.chat-composer-footer .chat-composer-editor';

/** A real mouse click at a point - `element.click()` is not what these components listen for. */
export async function clickAt(cx, x, y) {
  await cx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  for (const type of ['mousePressed', 'mouseReleased'])
    await cx.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    });
}

/**
 * Opens the conversation whose sidebar row CONTAINS `name`, then asserts the pane shows it.
 *
 * The post-condition is the point: a click that lands on the wrong row is exactly the failure being
 * guarded against, and nothing else in a run can detect it - every later assertion would simply be
 * measuring a different conversation and reporting it as this one.
 */
export async function openGroup(cx, name, { navigate = false, label = 'client' } = {}) {
  if (navigate) await goto(cx, '/chat');

  const locate = `(function () {
    var els = [].slice.call(document.querySelectorAll('button, [role=button], a, li'));
    var hits = els.filter(function (e) {
      return (e.innerText || '').indexOf(${JSON.stringify(name)}) !== -1 && e.getBoundingClientRect().width > 0;
    });
    hits.sort(function (a, b) { return a.innerText.length - b.innerText.length; });
    if (!hits.length) return null;
    var r = hits[0].getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             text: (hits[0].innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 50) };
  })()`;

  await until(cx, `${locate} !== null`, 25000);

  // RE-LOCATE ON EVERY ATTEMPT, because the coordinates go stale under a live list.
  //
  // The conversation list re-sorts as messages and group events arrive, so a rect read once and
  // clicked a moment later can land on a neighbouring row or on nothing at all - which presents as
  // a composer that never appears, i.e. as the app failing to open a conversation that is plainly
  // there. Same reasoning as `stableCentreOf` in `cdp.mjs`; three attempts, then let it throw,
  // because a row that will not open after three re-locations is a finding rather than noise.
  let row = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    row = JSON.parse(await evaluate(cx, `JSON.stringify(${locate})`));
    if (!row) throw new Error(`${label}: no sidebar row for ${name}`);

    await clickAt(cx, row.x, row.y);
    const opened = await until(cx, `!!document.querySelector('${COMPOSER}')`, 12000).catch(() => null);
    if (opened !== null) {
      await sleep(2500);
      if (await paneIs(cx, name)) return row.text;
    }
    console.log(`[groupnav] ${label}: attempt ${attempt} did not open ${name} (clicked ${JSON.stringify(row.text)})`);
    await sleep(2000);
  }
  throw new Error(`${label}: ${name} would not open after 3 attempts (last row ${JSON.stringify(row?.text)})`);
}

/** True when the OPEN conversation's pane names `name`. The group title is inside the pane. */
export function paneIs(cx, name) {
  return evaluate(
    cx,
    `(function () {
      var c = document.querySelector('${COMPOSER}');
      return c ? (c.closest('section').innerText || '').indexOf(${JSON.stringify(name)}) !== -1 : false;
    })()`
  );
}
