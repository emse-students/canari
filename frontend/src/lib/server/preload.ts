/**
 * Which assets earn a `Link:` preload header on an HTML response.
 *
 * **A STYLESHEET IN THIS DOCUMENT DOES NOT, AND THAT IS THE WHOLE OF THIS FUNCTION.** SvelteKit
 * emits BOTH halves for every stylesheet - `render.js` adds the `<link rel="stylesheet">` to the
 * head and, when this predicate says yes, a `<path>; rel="preload"; as="style"; nopush` header
 * beside it. The two travel in the SAME response, so the hint arrives with the tag it is hinting
 * at and buys nothing: a header preload pays off ahead of the body, which requires Early Hints
 * (103), and nothing in this estate sends one.
 *
 * Measured rather than argued, 2026-09-16. In Chrome on `/posts`, all six stylesheets record
 * exactly ONE resource-timing entry each, `initiatorType: "link"` - the tag fetched them and the
 * header produced no second, earlier request. In the user's Firefox the same six are reported
 * `preloaded with link preload not used`, once per file per load, on both reloads of that day's
 * export: six warning lines whose best case is a wasted hint and whose worst case is the 30 KB
 * main sheet fetched twice.
 *
 * JavaScript keeps its header. `rel="modulepreload"` is what lets ~130 chunks be discovered at
 * once and fetched multiplexed - measured at a 21 ms mean TTFB, every one a Cloudflare HIT - and
 * removing entries there does not remove the work, only delays discovering it.
 *
 * IT IS SVELTEKIT'S DEFAULT MINUS ONE TYPE, SPELLED AS `js` RATHER THAN `!== 'css'`. The default is
 * `type === 'js' || type === 'css'`, so fonts and plain assets have never carried a preload header
 * here; writing the negation would have silently STARTED preloading both, which is a wider change
 * than the one being made and was caught before it shipped.
 */
export const preloadableAsset = ({ type }: { type: string; path: string }): boolean =>
  type === 'js';
