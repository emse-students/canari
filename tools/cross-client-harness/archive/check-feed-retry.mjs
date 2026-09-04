#!/usr/bin/env node
/**
 * Verifies that the feed's "Reessayer" actually brings the posts back.
 *
 * Why this cannot be a unit test: the defect is entirely in WHERE the template reads
 * `postsOverride`. `data.posts` is a streamed promise from the load function, and an `{#await}`
 * over a REJECTED promise stays in `{:catch}` for the life of the component - so a refetch that
 * succeeded had nowhere to render. Nothing but a real render can see that, and the repo has no
 * component-rendering test setup.
 *
 * Two things this check has to do that are not obvious:
 *  - The failure is injected by patching `window.fetch` IN THE PAGE, not with CDP's offline
 *    emulation: on mobile `window.fetch` is the Tauri HTTP plugin's, so requests are made by a
 *    Rust client that CDP's Network domain never sees (proven - the retry's 200 was invisible to
 *    `Network.responseReceived`). The same recorder is therefore how the retry's fetch is read.
 *  - Navigation must stay CLIENT-SIDE, or the document reloads and takes the patch with it.
 */
import { client, evaluate, realClick } from '../chat.mjs';

const port = Number(
  process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 9222
);
const cx = await client(port, null, { focus: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = () =>
  evaluate(
    cx,
    `JSON.stringify({
      path: location.pathname,
      errorScreen: document.body.innerText.indexOf('Impossible de charger') !== -1,
      retryBtn: [].some.call(document.querySelectorAll('button'), function (b) { return /essayer/i.test(b.innerText); }),
      // PostCard's root carries \`group/card\`; there is no \`article\` and no \`data-post-id\` in the
      // feed, and counting those returned 0 on a page that was visibly rendering posts.
      cards: document.querySelectorAll('[class*="group/card"]').length,
      knownPost: document.body.innerText.indexOf('ParlerMarteau') !== -1
    })`
  );

// Leave the feed client-side so the trap installed next survives the round trip.
await realClick(cx, 'text=Discussions').catch(() => {});
await sleep(2500);

console.log(
  '[feedretry] trap:',
  await evaluate(
    cx,
    `(function () {
      if (window.__origFetch) return 'already';
      window.__origFetch = window.fetch;
      window.__failNext = true;
      window.__calls = [];
      window.fetch = function (input) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/api/posts') === -1) return window.__origFetch.apply(this, arguments);
        if (window.__failNext) {
          window.__failNext = false;
          window.__calls.push({ url: url.slice(0, 70), injectedFailure: true });
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        var entry = { url: url.slice(0, 70), status: null };
        window.__calls.push(entry);
        return window.__origFetch.apply(this, arguments).then(function (r) {
          entry.status = r.status;
          return r;
        });
      };
      return 'installed';
    })()`
  )
);

await realClick(cx, 'text=Feed').catch(() => {});
await sleep(5000);
const failed = JSON.parse(await state());
console.log('[feedretry] after the injected failure:', JSON.stringify(failed));
if (!failed.errorScreen || !failed.retryBtn) {
  console.log('[feedretry] VERDICT: SETUP FAILED - could not produce the error screen');
  await evaluate(cx, `(function(){ window.fetch = window.__origFetch; delete window.__origFetch; return 1; })()`);
  process.exit(2);
}

await realClick(cx, 'text=Réessayer').catch(() => {});
await sleep(8000);
const after = JSON.parse(await state());
const calls = JSON.parse(await evaluate(cx, `JSON.stringify(window.__calls)`));
console.log('[feedretry] fetches the app made:', JSON.stringify(calls));
console.log('[feedretry] after the retry:', JSON.stringify(after));

const refetched = calls.some((c) => c.status === 200);
const recovered = !after.errorScreen && after.cards > 0;
console.log(
  `[feedretry] VERDICT: ${refetched && recovered ? 'PASS' : 'FAIL'} ` +
    `(retry fetched 200 = ${refetched}, posts rendered = ${recovered}, cards ${after.cards})`
);

await evaluate(cx, `(function(){ window.fetch = window.__origFetch; delete window.__origFetch; return 1; })()`);
process.exit(0);
