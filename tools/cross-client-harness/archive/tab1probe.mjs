/**
 * WHY DID A HIDDEN TAB RAISE NO NOTIFICATION - a probe, not a row.
 *
 * TAB-1 recorded FAIL on 2026-09-05 with `permission: granted`, the recorder INSTALLED, the message
 * ARRIVED while hidden, and zero constructions and zero throws. So `new Notification` was never
 * reached, and the four ways that can happen are not distinguishable from the row's own record:
 * the product's guard read the tab as visible, its 800 ms per-conversation throttle swallowed the
 * call, `addMessageToChat` returned early on a duplicate id, or the runtime was misread as Tauri.
 *
 * This asks the client all four at the moment of arrival. It records NO verdict.
 */
import { awaitMessage, client, ensureConversation, evaluate, send } from '../chat.mjs';
import { background } from './tabs.mjs';
import { PORTS, peerNameFor } from '../names.mjs';

const marker = `T1P-${Math.random().toString(36).slice(2, 10)}`;
const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);
await ensureConversation(w2, peerNameFor(PORTS.W2));
await ensureConversation(w1, peerNameFor(PORTS.W1));

// The recorder, plus a log of EVERY decision input at the moment each message is appended.
await evaluate(
  w2,
  `(function () {
    var Real = window.Notification;
    var s = { calls: [], threw: [], adds: [] };
    function Rec(t, o) { s.calls.push({ title: String(t), body: String((o || {}).body || '') }); try { return new Real(t, o); } catch (e) { s.threw.push(String(e && e.message)); throw e; } }
    Object.defineProperty(Rec, 'permission', { get: function () { return Real.permission; } });
    Rec.requestPermission = function () { return Real.requestPermission.apply(Real, arguments); };
    window.Notification = Rec;
    // The four inputs, sampled by watching the console the app already writes.
    var log = console.log;
    console.log = function () {
      var line = Array.prototype.map.call(arguments, String).join(' ');
      if (line.indexOf('[ADD_MSG]') !== -1 || line.indexOf('Duplicate ignored') !== -1) {
        s.adds.push({ line: line.slice(0, 160), vis: document.visibilityState, focus: document.hasFocus() });
      }
      return log.apply(console, arguments);
    };
    window.__t1p = s;
    return 'ok';
  })()`,
);

const read = async () =>
  JSON.parse(
    await evaluate(
      w2,
      `JSON.stringify({
        store: window.__t1p,
        vis: document.visibilityState,
        focus: document.hasFocus(),
        perm: window.Notification.permission,
        tauri: !!window.__TAURI_INTERNALS__,
      })`,
    ),
  );

console.log('[probe] before hiding:', JSON.stringify(await read()));

const restore = await background(w2);
try {
  await send(w1, `${marker} hidden probe`);
  const arrived = await awaitMessage(w2, marker, 45000).then(
    () => true,
    () => false,
  );
  await new Promise((r) => setTimeout(r, 3000));
  const after = await read();
  console.log('[probe] arrived   :', arrived);
  console.log('[probe] visibility:', after.vis, 'focus:', after.focus, 'perm:', after.perm, 'tauri:', after.tauri);
  console.log('[probe] notifications constructed:', after.store.calls.length, 'threw:', after.store.threw.length);
  console.log('[probe] ADD_MSG lines while hidden:');
  for (const a of after.store.adds) console.log('   ', JSON.stringify(a));
} finally {
  await restore().catch((e) => console.error('[probe] restore failed:', e.message));
}

process.exit(0);
