# Leaving a Meta in-app browser - every site of the ecosystem

**Owner decision of 2026-11-25** ([decisions](../decisions/owner-decisions-of-2026-11-25.md)): when
any of our sites is opened inside the browser built into Messenger, Facebook, Instagram or Threads,
the page is not usable there; the only way forward is leaving it, automatically where the platform
allows. Backlog (the siblings and the readings):
[the entry](../backlog.d/p1-meta-in-app-browsers-are-left-not-used.md).

**Built in Canari and in front of MiConnect (2026-11-25); Sky, MiGallery, Portail-etu and Le Cercle
follow** (section 6). It replaces Canari's former in-app browser banner, whose rule was "a tap,
never a redirect": the owner overrides that rule for in-app browsers only. The login page's
"Ouvrir dans l'application" in an ordinary browser is unchanged
([mobile](mobile.md#leaving-an-in-app-browser-for-the-app)).

**Why.** A sign-in page opened from inside a Meta app was reported broken while the same link in
Safari worked. A WebView we do not
control - its storage, its cookie policy, its handling of redirects and custom schemes - is a
browser no gate here tests and no reading covers. Charter ([principes](../../principes.md)):
principle 2, *the essential is never lost* - a sign-in that silently fails in that browser is the
essential lost; principle 4, *independent for the essential* - an advertising platform's WebView
does not host our sessions.

## 1. Where an HTML response is produced, and who owns the layer

| Site | Public name lives on | First layer we own | Who writes the HTML |
|---|---|---|---|
| Canari (web) | the school's domain -> the host's nginx | the frontend container's nginx | SvelteKit adapter-node (`frontend-ssr`, `@ssr`); nginx for `@app_shell` when it is down |
| Canari dev | our Cloudflare zone -> tunnel -> the host | the same image | the same, **and Cloudflare caches the page 60 s** (`s-maxage=60`) |
| MiConnect (authentik) | the school's domain -> the host's nginx | MiConnect's compose project (`infrastructure/authentik/compose.yml`) | authentik's Django templates and Lit flow executor |
| Sky, Le Cercle, Portail-etu | the school's domain -> the host's nginx | the app container | SvelteKit adapter-node (bun), `src/hooks.server.ts` |
| MiGallery | our Cloudflare zone -> tunnel -> the app | the app container | SvelteKit adapter-node (bun); pages `private, no-store` |
| Legacy names | our Cloudflare zone | - | none: each answers `301` + `no-store` to the current name (measured 2026-11-25) |

**No single edge exists.** The one layer every request crosses is the host's nginx, and it is the
school IT department's ([durable-rules](../durable-rules.md)); Cloudflare reaches dev, MiGallery and
the legacy names only, not one production name of Canari, MiConnect, Sky, Le Cercle or Portail-etu.
So "one mechanism" (the homogeneity mandate, [ecosystem-convergence](../ecosystem-convergence.md))
is **one definition enforced at each origin**: `libs/leave-in-app-browser/`, byte-identical in every
repository, applied by the first layer each project owns. Five origins are SvelteKit hooks; MiConnect
is an nginx generated from the same files. The legacy names need nothing: their `301` lands on an
origin that enforces.

## 2. The ways out, and what is proven

**Nothing in this section was measured inside a Meta app**: no bench phone carries one. "Documented"
means a primary source; "reported" means third-party reports only.

### Android - a VIEW intent with no package and no fallback (owner, 2026-11-25)

`intent://<host><path>?<query>#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end`

- **What the system does with it** is Android's documented resolution of an https VIEW intent: the
  app holding a verified App Link for that URL (Canari, Android 12+, on a page it claims), otherwise
  the default browser (a chooser on Android 11 and older for an unverified link).
- **No `S.browser_fallback_url`.** It is a Chrome feature
  ([Chrome: Android intents](https://developer.chrome.com/docs/android/intents)); a WebView honours it
  only if its host app implements it, and **the fallback then loads INSIDE the in-app browser** - a
  path back to the place this page exists to leave. Without it there is no loop.
- **No `package=com.android.chrome`**: it reaches Chrome only, and fails where Chrome is absent or
  disabled.
- **Whether Meta's WebView launches an intent URL, and whether it does without a tap**, is its host
  app's `shouldOverrideUrlLoading` (which sees `WebResourceRequest.hasGesture()`). Chrome refuses an
  intent "initiated without user gesture" or "from a JavaScript timer" (same Chrome page); Meta's
  rule is **unknown** - the owner's reading.
- The page's `#fragment` cannot travel: an intent URL uses the fragment for its own parameters.

### iOS - Safari automatically, the app as a tapped second button (owner, 2026-11-25)

- **`x-safari-https://<host><path>`**, attempted on iOS 17 and later. **Undocumented by Apple.**
  Reported working on iOS 15, 17 and 18 and **not on 16**
  ([Tietze, update of 2024-06-20](https://christiantietze.de/posts/2023/05/safari-for-mac-url-scheme));
  "at least v17.0+" in [WebKit bug 240025](https://bugs.webkit.org/show_bug.cgi?id=240025), where a
  WebKit maintainer adds that an app that does not want to break out "doesn't have to": the host
  app's `WKNavigationDelegate` decides. **Whether Meta honours it, with or without a tap: unknown.**
- **`fr.emse.canari://open?url=<page>`**, Canari's claimed pages only (`iosAppOpenHref`), as a
  **tapped** second button. Never automatic: with the app absent nothing happens, and a page cannot
  tell "not installed" from success without a timer.
- **iOS 16 and older**: no automatic exit exists. The blocking page with its instructions and the
  copy button is the whole answer.
- A Universal Link is never consulted from inside a WebView, and a page Safari opens directly does
  not trigger one either.

## 3. The mechanism

### The definition - `libs/leave-in-app-browser/`

| File | What it holds |
|---|---|
| `detect.ts` | `META_IN_APP_BROWSER_RULES` (ordered: Messenger `FBAN/Messenger`/`FB_IAB/Orca-Android`, Instagram `Instagram <n>`, Threads `Barcelona <n>`, Facebook `FBAN/`/`FBAV/`/`FB_IAB/`/`FBIOS`), `detectMetaInAppBrowser`, `exitHref` |
| `gate.ts` | `isTopLevelDocument`, `GATE_EXEMPT_PREFIXES` (`/api/`, `/_app/`, `/.well-known/`), the interstitial's headers and its CSP computed from its bytes, `leaveInAppBrowserResponse` |
| `interstitial.html` | the one page |
| `nginx.ts`, `generate.ts` | MiConnect's gate, generated |
| `fixtures.json` | user agents and the answer every adapter owes |

**The patterns are written in the subset JavaScript and nginx PCRE read identically** (literals,
`|`, `[0-9]`, a space; a test refuses anything else), because the same strings become MiConnect's
`map`. **Never widen a pattern to "facebook"**: Meta's link-preview fetcher,
`facebookexternalhit/1.1`, draws every preview card in those apps
([Meta: web crawlers](https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/)), and it
and the `meta-external*` / `meta-webindexer` fetchers carry none of the tokens - the fixtures pin all
of them as let through. Threads' token is its code name, as reported; unmeasured.

### Which requests get the interstitial

A **top-level page request**: `GET` or `HEAD`, and `Sec-Fetch-Dest: document` when the browser
sends it, else an `Accept` asking for `text/html`. Never a fetch, an image, a script, a frame, a
`POST`, `/api/`, `/_app/`, `/.well-known/` (the association files must keep answering) or
`/outpost.goauthentik.io/` (authentik's forward-auth answers its proxy with a STATUS, and a `200` from
the interstitial there would read as "authenticated"). A blocked page means its subresources are
never asked for.

### The interstitial

One static file, the same bytes everywhere, and **the one user-visible text of Canari outside
Paraglide**: it is served in front of MiConnect's authentik and on four other sites, where no
Paraglide exists, so its French and English are in the file and its script picks by
`navigator.language` (French by default, and without script). No external resource, inline CSS
and one inline script, `prefers-color-scheme`, real links and buttons, a status line read aloud.

- **Headers**: `Content-Security-Policy: default-src 'none'; script-src 'sha256-<its script>';
  style-src 'sha256-<its style>'; img-src 'none'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'` (computed from the bytes served, so it cannot drift),
  `Cache-Control: no-store`, `Vary: User-Agent`, `X-Robots-Tag: noindex, nofollow`, `nosniff`,
  `Referrer-Policy: no-referrer` as the gate writes them (MiConnect and the siblings); status `200`.
  **On Canari, nginx owns the last two** (below), so the interstitial carries Canari's own
  `Referrer-Policy`, which is NONE on most paths. Nothing depends on it: the page loads no resource
  and its only ways out (an intent, `x-safari-`, the app's scheme) send no referrer.
- **Content**: the site's host, one sentence, the exit button where a door exists ("Ouvrir dans
  Safari" / "Ouvrir dans le navigateur"), the app button when the server wrote one into the
  `leave-iab-app` meta (Canari, iOS, a claimed page), the manual way out ("••• puis Ouvrir dans
  Safari", "⋮ puis Ouvrir dans Chrome"), the link in full, and "Copier le lien". No link into the site.
  Without JavaScript the link field stays empty, so a `<noscript>` line says to copy the address from
  the address bar (French shown, English in its hidden block).
- **One automatic attempt, no timer**: on load the script navigates once to the exit URL (Android:
  the intent; iOS 17+: `x-safari-`). If the in-app browser does not let it leave, the page with its
  buttons is the end state. Its `exitFor` mirrors `detect.ts`'s `exitHref`, and the source's test runs
  both on every fixture.

### Canari

- **`hooks.server.ts`** calls `canariLeaveInAppBrowser` (`lib/server/leaveInAppBrowser.ts`) first,
  before any page head is built. The frontend nginx keeps a `no-store` the SSR declared (the
  `$ssr_cache_control_declared` map), so the interstitial is never stamped `s-maxage=60`. In `@ssr`
  nginx hides the interstitial's own `Referrer-Policy` and `X-Content-Type-Options` and writes its
  own: `nosniff` always, and `Referrer-Policy` from `$capability_referrer_policy` - set on the
  capability paths (`/f/`, the join links, the sign-in) and ABSENT everywhere else. So neither header
  is ever sent twice, and the interstitial on Canari carries no `Referrer-Policy` on most paths
  (harmless, see the header list above).
- **The client guard is LOAD-BEARING** (`lib/mobile/inAppBrowserGuard.ts`): it is what stands
  wherever the server's answer was skipped - `@app_shell` (nginx's shell while `frontend-ssr` is
  down), and dev's Cloudflare cache until the bypass rule below exists (a page cached for a real
  browser, or filled by a link-preview fetch, served to an in-app browser). Reaching it accuses that
  path, so it logs at **warn**. The root `load` asks it FIRST and returns - no silent refresh, no
  redirect to login - so the address it captures is the one the visitor was sent; the root layout
  then draws `LeaveInAppBrowser.svelte` in place of the whole app, and every effect that starts
  something (push, the publish queue, birthdays, the form draft resend, the admin counts, the DND
  ask, the route-code preload) is off while it holds; `onMount` returns after `markRouterReady`.
  Same doors, same single attempt; its strings are Paraglide's (`leave_iab_*`). Tests:
  `inAppBrowserGuard.test.ts`, `routes/layout.inAppBrowser.test.ts`.
- `frontend/src/lib/leaveInAppBrowser/` is the vendored copy, held to the source by
  `declared-duplicates`; its exports are `ignoreIssues` in `knip.json` ([dead-code](../dead-code.md)).
- The former banner (`OpenInAppBanner`, `detectInAppBrowser`, `openInAppOffer`) is deleted.

### MiConnect - the `gate` service

`infrastructure/authentik/compose.yml` gains `gate`: nginx (the image Canari's edge pins) with
`infrastructure/authentik/leave-in-app-browser/` mounted, **generated** by
`bun libs/leave-in-app-browser/generate.ts` and held by `--check` in `make test-ci-scripts`.

- It holds **`AUTHENTIK_PUBLISH`** - the address the host's nginx proxies to, so the vhost does not
  move. authentik's `server` now publishes only `AUTHENTIK_DIRECT_PUBLISH` (default `127.0.0.1:0`,
  an ephemeral loopback port), which `deploy-stack.sh` reads with `docker port` for its probes.
- **Everything else passes through as received** (`X-Forwarded-*` from the host's nginx included):
  only `Host` is set, and `Upgrade`/`Connection` for authentik's WebSockets. authentik sees one more
  private hop, inside its default trusted proxy ranges.
- **authentik's address is resolved per request** from Docker's DNS: a release recreates `server`
  (`--no-deps`), and an upstream resolved once would answer 502 after every release.
- It logs one line per interstitial (app and the path's first segment); authentik keeps its own
  access log.

**Rehearsed** by `infrastructure/authentik/test-blueprints.sh`, which boots the real compose file
under a throwaway project and, after the blueprints, drives every fixture through the real gate in
front of the real authentik, checks the interstitial's headers, that a fetch, an API path and an
outpost path pass (a Messenger user agent asking `/outpost.goauthentik.io/` as a page included), and
that a recreated `server` is reached with no gate restart; then `down -v`.

**Its liveness is watched**: `deploy-stack.sh` probes `/-/health/live/` through the FRONT DOOR -
`AUTHENTIK_PUBLISH`, the address the host's nginx proxies to, which is the gate once it stands and
authentik's server before - in every `health` and release check and in the morning
`miconnect-preflight` (which a stable's gate 8 reads). One probe, whichever stands there, so it needs
no change on the day the gate is put in place.

#### MiConnect in production - the hand step

**The release does not deploy this service**: it moves only the authentik image tag, and the host's
compose file is MiConnect's own, kept by hand ([authentik](../infrastructure/authentik.md)). Our
containers are ours to change (owner, 2026-11-19); the host's nginx is not touched.

**PRECONDITION: every sibling site ships its own gate first** (section 6). A sibling page opened in
an in-app browser starts its OIDC sign-in THERE (state and PKCE cookies in the in-app browser's
jar); a gated authorize would send the visitor to Safari, whose callback carries no such cookie, and
the sign-in fails. Once each sibling refuses the in-app browser itself, no sign-in starts there.
Canari gates itself in this same pull request.

The step, in one window, by the lead:

1. Copy `infrastructure/authentik/leave-in-app-browser/` beside the stack's compose file on the host.
2. Add the `gate` service and the `server` publish change of this repository's `compose.yml` to the
   host's copy; in the stack's `.env`, keep `AUTHENTIK_PUBLISH` (now the gate's) and set nothing for
   `AUTHENTIK_DIRECT_PUBLISH`.
3. Read `AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS` in the stack's `.env`: absent (authentik's default
   includes the Docker ranges) or covering the compose network.
4. `docker compose up -d --no-deps server` (the server is recreated and releases `AUTHENTIK_PUBLISH`),
   THEN `docker compose up -d gate` (the gate takes it). The gap between the two is the only window
   in which MiConnect does not answer.
5. Verify: `deploy-stack.sh health --project <stack>` (its front-door probe asks `/-/health/live/`
   through `AUTHENTIK_PUBLISH` with an ordinary user agent, and must answer `200`); a sign-in end to
   end in a browser; the page asked with a Messenger user agent (`curl -A` a fixture,
   `-H 'Accept: text/html'`) answering the interstitial; `/outpost.goauthentik.io/` asked the same
   way NOT answering it.
6. Rollback, in this order: `docker compose rm -sf gate` while the NEW compose file is still in place
   (the old file no longer names `gate`, so compose could not remove it), then put the previous
   compose file back, then `docker compose up -d --no-deps server` (it takes `AUTHENTIK_PUBLISH`
   again), then `deploy-stack.sh health --project <stack>`.

### Dev's Cloudflare cache - the owner's one-off rule

Cloudflare's cache does not key on `User-Agent`, and dev's pages are cached 60 s, so a page cached
for a real browser would be served to an in-app browser for up to a minute. One Cache Rule on the
`canari-emse.fr` zone closes it (the project's token cannot read or write rulesets):

- Dashboard: `canari-emse.fr` -> Caching -> Cache Rules -> Create rule.
- Name: `Meta in-app browsers bypass the cache`.
- Expression (Edit expression):
  `(http.user_agent contains "FBAN/") or (http.user_agent contains "FBAV/") or (http.user_agent contains "FB_IAB/") or (http.user_agent contains "FBIOS") or (http.user_agent contains "Instagram ") or (http.user_agent contains "Barcelona ")`
- Cache eligibility: **Bypass cache**.
- Order: **last** (below the rule that makes pages eligible): among Cache Rules a later match
  overrides an earlier one.
- Check: `curl -sI -A "<a Messenger fixture>" -H 'Sec-Fetch-Dest: document' https://dev.canari-emse.fr/`
  answers `cf-cache-status: BYPASS` (or `DYNAMIC`) and `cache-control: no-store`.

## 4. What the owner reads on his phone

For each of Messenger, Facebook, Instagram and Threads, on the iPhone (iOS 17+, and 16 if one is at
hand) and on Android, open a link to a page of the pre-release (dev) and to MiConnect, sent in a
conversation or a post:

1. the interstitial shows, and nothing of the site renders behind it;
2. the automatic exit fires without a tap - and where it lands (browser, app, nothing);
3. if not, the primary button exits on a tap - and where;
4. Android with the Canari app installed: a post opens **in the app**; without the app, in the
   default browser; never back in the in-app browser;
5. iOS on a Canari post: "Ouvrir dans l'application" opens the app on that post;
6. "Copier le lien" puts the link on the clipboard;
7. the link preview card in the conversation still shows the page's title and image;
8. after an automatic exit the in-app browser refused, the interstitial is still on screen, whole
   (nothing blank, nothing half-loaded behind it).

Each answer goes into this page, and an exit Meta refuses (2, 3) becomes the manual instruction's
job, not a new mechanism.

## 5. The tests

- `libs/leave-in-app-browser/leave-in-app-browser.test.ts` (`make test-ci-scripts`): the detector on
  every fixture (Meta's four apps on both systems in; crawlers, unfurlers, real browsers and the app's
  WebView out), the pattern subset, the exits, the interstitial's own script against `exitHref`, the
  gate (documents vs `/api`, `/_app`, `/.well-known`, fetches, frames, `POST`, crawlers), the headers
  and the CSP hashes, the page's shape, and the nginx map generated from the same rules.
- `generate.ts --check` (`make test-ci-scripts`): MiConnect's committed gate equals what the source
  writes.
- `frontend/src/lib/server/leaveInAppBrowser.test.ts`: Canari's hook on every fixture, the paths
  and requests let through, the iOS app link on a claimed page only, the log line.
- `declared-duplicates`: the frontend copy equals the source.
- `test-blueprints.sh` (CI job `test-miconnect-blueprints`, which a change under
  `libs/leave-in-app-browser/` now triggers): the live gate in front of the live authentik.

## 6. The siblings - Sky, MiGallery, Portail-etu, Le Cercle

Not in Canari's pull request. Each, one pull request in its own repository, through its own release.

**THE ROLLOUT ORDER IS DECIDED: the siblings first, MiConnect's gate LAST** (decision item 11). A
gated authorize in front of a site that still runs inside the in-app browser breaks that site's
sign-in there (the precondition of [the hand step](#miconnect-in-production---the-hand-step)).

**The Reseau console (#4102), an external relying party, is in the same situation and is ACCEPTED,
not exempted**: it is an operators' supervision tool opened from a desktop browser, never a link
shared in a Meta app, and an exemption could not be scoped to it anyway - its authorize URL is
MiConnect's own, the same path every relying party uses. If an operator ever opens it in an in-app
browser, the interstitial's way out is the answer.

Each sibling pull request:

1. vendor `detect.ts`, `gate.ts` and `interstitial.html` byte-identical, at the site's own path;
2. call `leaveInAppBrowserResponse` first in `src/hooks.server.ts` (`sequence` where a hook exists),
   with `site` set and no `appLinkFor`; import the page with `?raw`;
3. a test of the hook on `fixtures.json` (copied as well), and the copies added to
   `tools/ecosystem-shape` (Sky, MiGallery, Portail-etu; Le Cercle is on GitLab, outside it, and
   compares its copies against a pinned hash in its own CI);
4. the owner's readings on that site's pre-release.
