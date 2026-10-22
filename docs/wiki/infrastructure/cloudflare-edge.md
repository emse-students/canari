# Cloudflare edge

**Source of truth: the Cloudflare zone itself.** That is the problem this page exists to contain -
the edge is production infrastructure with no representation in git, so nothing in a review, a test
run or a deploy can see it change. It is configured by hand in a dashboard, and a hand-made change
there outranks everything in this repository.

Related: [nginx](nginx.md) (the origin behind it), [docker](docker.md).

## Topology

Every hostname on the zone is a **proxied CNAME to a Cloudflare Tunnel** (`*.cfargotunnel.com`), so
there is no public IP and no inbound port on the origin. `cloudflared` forwards to
`http://localhost:8080` -> nginx:80.

One consequence worth stating, because it is the opposite of the usual advice: the zone's **SSL/TLS
mode is not a meaningful control here**. There is no classic edge-to-origin TLS connection to make
strict - the tunnel is its own authenticated transport, and what `cloudflared` does on the far end is
decided by the tunnel's ingress rules, not by the zone setting. Raising it from Full to Full (strict)
buys nothing and can break the tunnel.

## Who owns a response header

**The origin owns every response header, including `Content-Security-Policy`. The edge adds none.**
At the origin, nginx writes them all except a PAGE's policy, which SvelteKit writes because only it
knows the hashes of the page's scripts ([below](#no-script-runs-unless-the-policy-names-it-2026-10-22)).

This is a rule, not a description, and it was written after the incident below.

A Transform Rule was added to the zone on 2026-08-12 with `operation: add` and the description
"CSP permissive", intending to loosen the policy. It did the exact opposite, and would always have
done the exact opposite:

> **A browser enforces every CSP header it receives INDEPENDENTLY. The effective policy is their
> INTERSECTION. A second policy can therefore only ever REMOVE permissions - it is structurally
> incapable of granting one.**

So a rule whose only possible effect is to restrict was named for the opposite of what it could do,
and every reading of it in the dashboard confirmed the wrong intention.

What it removed, specifically, is the trap worth remembering: **`*` matches network schemes only.**
It does not cover `blob:`, `data:` or `filesystem:`. The added policy declared `connect-src *`,
`worker-src *` and `media-src *`, so against an origin policy that explicitly allows `blob:` in all
three, the intersection forbade it:

| Operation from a `blob:` URL | Before | After removal |
|---|---|---|
| `fetch()` | blocked | allowed |
| `XMLHttpRequest` | blocked | allowed |
| `new Worker()` | blocked | allowed |
| `<img src>` | allowed | allowed |

`<img>` survived only because the added policy happened to spell `img-src * data: blob:` in full.
That is what made the failure look arbitrary from the outside: media previews rendered, so the CSP
looked fine, while three other capabilities were gone.

### How to measure this, and the reading that settles it

Every indirect signal here is ambiguous, and two of them nearly produced a wrong conclusion:

- a blocked `fetch` and an unreachable network **both** throw `TypeError: Failed to fetch`;
- a refused `<video>` reports `MEDIA_ERR_SRC_NOT_SUPPORTED` (code 4) - **the same code an
  unplayable codec reports.** A probe built on a hand-made 24-byte MP4 therefore reports "blocked"
  whether or not CSP had anything to do with it.

Only the browser's own `securitypolicyviolation` event names the directive that refused, so it is
the one reading that distinguishes "CSP said no" from "this happened to fail". An empty violation
list is the verdict; anything else is a guess. The probe that established this was a one-shot,
removed with the harness residue; what it did is the whole of it - listen for
`securitypolicyviolation` on the page, exercise the load, and read the collected violations rather
than the element's own error.

Counting the headers is the other half, and `curl -sI` is enough. **A PAGE carries exactly two**
since 2026-10-22 - SvelteKit's full policy and nginx's `frame-ancestors 'none'` (below) - and every
other response exactly one. **One more than that means the edge is injecting one.**

### No script runs unless the policy names it (2026-10-22)

**Scripts have no `'unsafe-inline'` and no `'unsafe-eval'`, on the web and in the native WebView.**
An injected `<script>` or an `onerror="..."` attribute is refused; only the bundle (`'self'`), the
inline scripts whose SHA-256 the policy carries, and WebAssembly compilation run.

**Who writes which policy:**

| Response | Policy | Written by |
|---|---|---|
| A web page (`@ssr`, a header) | the directives below, plus the hash of SvelteKit's start script and of each of `app.html`'s four inline scripts | SvelteKit, `kit.csp` in hash mode, built from `frontend/src/lib/security/cspPolicy.js` (web build only) |
| The degraded shell (`@app_shell`) | the same, as a `<meta>` written at prerender | SvelteKit |
| Both page blocks, in addition | `frame-ancestors 'none'` - the one directive a `<meta>` cannot carry | nginx, `snippets/csp-page.conf` |
| Every other web response (scripts, workers, the WASM binary, JSON, media) | the same directives, no hash | nginx, `snippets/csp.conf` |
| The native WebView (Android, iOS) | its own directive map, plus the hashes Tauri computes for every inline script it embeds | `frontend/src-tauri/tauri.conf.json` (`app.security.csp`) |

**Why a page is not given `csp.conf`.** A second policy is INTERSECTED with the first, and
`csp.conf` holds no hash - only the build knows them - so it would refuse every inline script of the
page and leave it blank. `static-headers.test.mjs` fails a page block that includes it. **Why the
two copies exist anyway.** A worker's policy is its OWN response's, so the MLS worker compiles its
WebAssembly under nginx's `'wasm-unsafe-eval'`; `csp.test.ts` holds `csp.conf` equal to
`cspPolicy.js`. **Hash, never nonce:** a page is cached at the edge for 60 s, and a nonce would be
served to every visitor of that minute.

**Why each source is there** is written once, beside the directives, in `cspPolicy.js`. The ones a
narrowing must not touch: `'wasm-unsafe-eval'` (`WebAssembly.instantiate` of the MLS engine - without
it every encrypted conversation stops), `img-src https:` (a GIF pasted from any host is drawn
directly, owner decision 2026-10-18, [chat](../frontend/modules/chat.md#the-gif-relay-no-readers-browser-asks-klipy-for-a-gif-2026-10-18)),
and `style-src 'unsafe-inline'` (Svelte `style=` attributes; styles cannot run code). `connect-src`
names no bare `ws:`/`wss:` any more: both WebSockets are same-origin, and the estate's own `wss://`
names are listed, because `'self'` matches `wss:` only under CSP Level 3 (an older Safari).

**What made the inline scripts hashable.** `app.html`'s WASM preload used to be written by the server
with the content-hashed binary URL INSIDE it - a new text, so an unhashable one, on every build. The
script is now fixed text in `app.html`; the server writes the URL into the attributes of the marker
`<meta>` it reads (`frontend/src/lib/server/wasmPreload.ts`). The trombinoscope export's photo
fallback was an `onerror="..."` attribute and is a listener (`trombinoscope.ts`); `csp.test.ts` fails
on any inline handler left in an HTML string.

**The native policy.** `connect-src` names Tauri's IPC bridge (`ipc:`, `http://ipc.localhost`) and,
in `https` and `wss` form, every backend a store build may bake (the names
`.github/scripts/lib/backend-url.sh` classifies): a read from the API goes through the WebView's own
`fetch` (`fetchRouting.ts`), and the call signalling socket is the WebView's. The HTTP and WebSocket
PLUGINS do not go through the policy at all - their reach is the capability scope
(`capabilities/default.json`). Tauri would also add the hash of each inline `<style>` to `style-src`,
which makes a browser IGNORE `'unsafe-inline'` there; `dangerousDisableAssetCspModification:
["style-src"]` stops that for that one directive. **The local-estate overlay**
(`tauri.local.conf.json`, merged over the release config and read verbatim by `ios.yml`'s
local-device build) widens `connect-src`, `media-src` and `img-src` to `http:`/`ws:`; no release
build may name a plaintext origin. No capability declares `remote`, so no page served from the
network is given the IPC.

**Not done, and why.**
- **`require-trusted-types-for 'script'`:** Svelte 5 builds every component's DOM by assigning
  template HTML to `innerHTML`, and `{@html}` does the same. Under Trusted Types each of those throws
  unless a DEFAULT policy passes strings through - which is the absence of the control under its
  name. Not feasible without a renderer that does not write `innerHTML`.
- **WebKit before 16 and Chromium before 97 do not know `'wasm-unsafe-eval'`** and refuse
  WebAssembly under any policy without `'unsafe-eval'` - which stays out. So:
  - **the iOS app needs iOS 16** (owner decision 2026-10-22, [mobile](../frontend/mobile.md#ios-project));
    a web visitor on Safari 15 had the same limit before this change;
  - **Android**: the native WebView is the Android System WebView, updated through the Play Store
    apart from the OS. One older than 97 (released January 2022) would refuse the MLS engine; the
    app requires API 28, and a device that has not updated its WebView since then is the only case.

**What the edge may inject, and the policy now refuses.** Several Cloudflare features rewrite an HTML
response to add an inline or a third-party script: Bot Fight Mode / JavaScript detections, Web
Analytics (automatic injection), Rocket Loader, Email Address Obfuscation, Zaraz, Browser Insights,
the challenge / "Under Attack" interstitials and Automatic Platform Optimization. Under this policy
each one is refused on the page (and Rocket Loader would break every script). Which of them are on for
the zones in front of the web estates has NOT been read; it is a check owed before the stable, in
the dashboard - none is fixed by widening the policy.

**Also in the policy's wake.** pdf.js needs no eval: the 6.x line dropped its `new Function` glyph
compiler and the `isEvalSupported` option with it (no `new Function` in `pdfjs-dist/build`), so there
is nothing to switch off. `tauri dev` has its own `devCsp`: the same
script rules, plus the Vite server on port 1420 (its scripts and its hot-reload WebSocket).

**The reading this owes**, because a refusal is indistinguishable from an ordinary failure: load the
web app and the Android app, open a chat, a community, an image and a video, the GIF picker, the PDF
viewer, a trombinoscope export and the sign-in, and read the console for `securitypolicyviolation`
(see the measurement above). An empty list is the verdict.

### The origin policy is stated once, and it is a description of the client's code

`infrastructure/local/Dockerfile.frontend` writes the policy into `/etc/nginx/snippets/csp.conf` and
every block that sets response headers pulls it in with `include`. That indirection exists because
**nginx's `add_header` REPLACES the inherited set rather than adding to it**, so each of the three
blocks that sets a header of its own (the server block, `location /`, the asset blocks) has to carry the
whole policy - the two PAGE blocks excepted, above - - and three verbatim copies of a security policy is precisely how one of them keeps an
old value after the other two are updated. One definition makes that impossible.

`frontend/src/lib/security/csp.test.ts` asserts the invariants: one declaration per snippet, more
than one `include`, the three policies above free of `'unsafe-inline'`/`'unsafe-eval'`, KLIPY's GIF host `static.klipy.com` present in `connect-src` and its search API
`api.klipy.com` ABSENT (the search goes through chat-delivery since 2026-10-16,
[chat](../frontend/modules/chat.md#the-gif-search-goes-through-canari-2026-10-16)), and no bare
scheme there. Since the GIF relay (2026-10-18) the current bundle reads no byte from
`static.klipy.com` either; the host stays listed for a web tab still on an older bundle
([chat](../frontend/modules/chat.md#the-gif-relay-no-readers-browser-asks-klipy-for-a-gif-2026-10-18)). It lives in the
frontend suite on purpose - what invalidates the policy is frontend code calling a host nobody
added.

**The defect that produced this (2026-08-17): attaching a GIF to a post comment did nothing.**
`connect-src` named `https://api.klipy.com`, the GIF picker's search API, and nothing else. But the
picker hands back a URL on `https://static.klipy.com`, and a comment's media is end-to-end
encrypted, so the client must READ those bytes before it can encrypt and upload them. The grid
rendered normally, because `img-src` is `https:` - so the feature looked alive:

| What the picker does | Directive that governs it | Verdict before the fix |
|---|---|---|
| Search KLIPY | `connect-src https://api.klipy.com` | allowed |
| Render the grid thumbnails | `img-src https:` | allowed |
| Read the chosen GIF's bytes | `connect-src` - host absent | **blocked** |

**Displaying a remote image and reading its bytes are two different permissions.** A wide `img-src`
next to a narrow `connect-src` is the correct shape - the feed renders arbitrary user-posted image
URLs, while what the app may read into memory stays an allowlist - and it is also the shape that
makes a missing `connect-src` host look like a broken button rather than a policy.

Measured before fixing, so the allowlist is a fact rather than a guess: 1 440 media URLs across
KLIPY's trending and two searches, **all on `static.klipy.com`**. The failing request was captured
on prod against the real header - the browser names the directive itself:

> Connecting to `https://static.klipy.com/...gif` violates the following Content Security Policy
> directive: "connect-src 'self' blob: wss: ws: ... https://api.klipy.com". The action has been
> blocked.

## Administrative hostnames are gated by Cloudflare Access

Every administrative interface published through a tunnel sits behind **Cloudflare Access**, in front
of the application's own login. One reusable Access **group** holds the allowlist and every
application references it, so adding or removing an administrator is one edit in one place rather
than one per hostname.

**Which hostname serves which product is deliberately not written here** - this repository is public,
and a gated door still does not need a signpost.

Two things learned doing it, both general:

- **THE ACCOUNT IS THE UNIT OF AUDIT, NOT THE ZONE.** This account carries three zones and three
  tunnels. Auditing the one zone that prompted the question left an administrative interface fully
  open on another, and the DNS listing of the first zone could not have revealed it.
- **A SECOND HOSTNAME CAN NAME THE SAME DESTINATION, AND GATING ONE GATES NOTHING.** Two hostnames
  on two different zones resolved to the identical internal admin-console origin. The **tunnel
  ingress table is the authoritative list of what is published** - `GET
  /accounts/{account}/cfd_tunnel/{id}/configurations` - because it maps hostname to *service*, which
  is what makes the duplicate visible. A DNS listing shows names, not destinations, so it cannot.

Before gating anything, check what already calls it **by that public name**: an internal consumer
reaching a service by its private address is unaffected, one reaching it by its public hostname
breaks the moment Access is applied. `docker inspect <container> --format '{{range .Config.Env}}...'`
answers it, and the answer decides whether the change is safe rather than being assumed.

## Settings that are deliberate

Read the live values with `GET /zones/{zone}/settings`; these are the ones with a reason attached.

| Setting | Value | Why |
|---|---|---|
| `min_tls_version` | `1.2` | Was `1.0`. TLS 1.0/1.1 are deprecated and offer nothing here - every browser and both mobile runtimes have done 1.2 for a decade |
| `email_obfuscation` | `off` | It rewrites addresses inside HTML responses and injects a `/cdn-cgi/` script to undo the rewrite. Free mutation of SSR output that renders user content, for no benefit on a site behind auth |
| `websockets` | `on` | Required by `/api/ws` |
| `rocket_loader` | `off` | It defers and re-orders scripts, which breaks SvelteKit hydration |
| `browser_cache_ttl` | `14400` | **Left alone on purpose.** It looks like it should override the origin's `max-age=31536000, immutable` on `/_app/immutable/`, and it does not - measured through the edge, the origin's value arrives intact. The theory was refuted, so the setting stays |
| `ssl` | `full` | See the tunnel note above - not a meaningful control on this zone |
| `0rtt` | `off` | 0-RTT permits replay of early data |

## Zone rulesets

Four zone-level rulesets carry rules. `http_response_headers_transform` is **empty and must stay
empty** - see above.

| Phase | Rule |
|---|---|
| `http_response_headers_transform` | *(none - deliberate)* |
| `http_request_dynamic_redirect` | `www.` -> apex, 301 |
| `http_config_settings` | BIC disabled on the auth subdomain |
| `http_request_cache_settings` | cache bypassed on the auth subdomain; **`/_app/immutable/*` eligible for cache, TTL from the origin** |

### THE EDGE CACHES BY FILE EXTENSION, NOT BY WHAT THE ORIGIN ASKS FOR

The origin sends `Cache-Control: public, max-age=31536000, immutable` on the whole of
`/_app/immutable/`, and until 2026-09-16 Cloudflare ignored it for some of them. **Its default
caching is decided by the file EXTENSION**: `.js` is on the list, `.wasm` is not. Measured on
production with three requests, which is all it takes:

| asset | `cf-cache-status`, before |
| --- | --- |
| `_app/immutable/entry/app.*.js` | `HIT` |
| `_app/immutable/assets/mls_wasm_bg.*.wasm` | `DYNAMIC` |
| `fonts/*.woff2` | `BYPASS` (the origin said `no-store`; fixed in v0.18.5) |

So every browser without the file paid a full origin round trip for the 723 kB encryption engine -
13 222 ms on the link measured that day, on every release, for ever. **A correct `Cache-Control` is
not a cached response here.** The Cache Rule above is what lifts it, and it is the statement of
intent: *do not* rename an asset to an extension the default list likes, which would lie about its
type to the next reader and move the MIME assertion somewhere else.

Two traps cost three attempts at the form. **`http.request.full_uri` carries scheme and host**, so
`starts_with(full_uri, "/_app/...")` can never match - the field is `http.request.uri.path`. And
**the wildcard operator matches the WHOLE path**, so `/_app/immutable/` without a trailing `*`
matches that exact path and nothing under it.

One command settles whether it still holds. **Its old companion clause - "and an HTML route still
answers `DYNAMIC`" - was retired on 2026-09-17**, when HTML deliberately became cacheable; the
section below replaces it with the reading that now bounds the rule.

```sh
curl -sSo /dev/null -D - -H 'Accept-Encoding: br'   https://canari-emse.fr/_app/immutable/assets/mls_wasm_bg.*.wasm | grep -i cf-cache-status
```

Measured after deployment: `MISS` on the first request, `HIT` on the second.

### THE SHELL IS CACHED AT THE EDGE AND NOWHERE ELSE, AND THE DEPLOY SAYS WHEN IT EXPIRED

A second Cache Rule, created by the user on 2026-09-17, makes everything outside `/api/` and
`/internal/` eligible with **Edge TTL "use cache-control if present, bypass if not"**. That phrasing
is the whole design: the tunable stays in this repository, in
`infrastructure/local/Dockerfile.frontend`, rather than in a console nobody diffs.

**BYPASS AND DYNAMIC ARE NOT THE SAME ANSWER, AND THE DIFFERENCE IS HOW YOU CHECK THIS RULE WITHOUT
READING IT.** Neither token in this project may read a ruleset - both answer `Authentication error`
on `/rulesets/phases/http_request_cache_settings/entrypoint` - so the rule's presence is established
from the outside instead:

```sh
curl -sSI https://canari-emse.fr/ | grep -i cf-cache-status
```

`DYNAMIC` would mean Cloudflare judged the response **ineligible**, and therefore that no rule covers
it. `BYPASS` means Cloudflare judged it **eligible and the origin declined**, which only the rule can
produce. On 2026-09-17, before the origin changed, `/` answered `BYPASS` twice.

**THE ORIGIN NOW SAYS `public, max-age=0, s-maxage=60`.** The two halves answer two different
questions, and the asymmetry between them is the reason there are two:

| | who may hold the shell | can it be told to forget |
| --- | --- | --- |
| `s-maxage=60` | Cloudflare | **yes** - `serve-prod.yml` purges the zone after the health check |
| `max-age=0` | the browser | **no**, ever |

That matters because a shell which outlives its build names content-hashed chunks the next image does
not contain: it is a **blank** page, not an old one. At the edge that is recoverable; on a disk it is
not, which is the whole of `max-age=0`.

**60 SECONDS IS THE SMALLER OF TWO NUMBERS THAT AGREE.** It is the freshness budget `serverSeo.ts`
had already set itself for these same bytes, and it is the ceiling on how long a stale shell could
break the site if the purge failed to run. There is no `stale-while-revalidate` for exactly that
reason.

**THE PURGE DERIVES ITS ZONE FROM THE TOKEN.** `CLOUDFLARE_CACHE_PURGE_TOKEN` carries `#zone:read`
beside `#cache_purge:edit`, so the step asks the token which zone it is rather than keeping a second
secret that could silently disagree with the first. It asserts the match unique and anchored on the
zone NAME - there is no `result[0]`, because **`jq` is not installed on the self-hosted runner** - and
it fails the job, loudly, on a missing token, a zone count other than one, or a refusal. It quotes
Cloudflare's `"message"` fields only: the success body carries the account id and the name servers,
and this repository is public.

**`dev.canari-emse.fr` IS ON THIS ZONE AND IS NOT PURGED.** `purge_everything` is zone-wide, so a dev
deploy purging would flush production's cache on every alpha. Dev's exposure is up to 60 s of blank
page after a deploy, bounded by `s-maxage` and by nothing else - the same bound that protects
production when the purge fails.

**IT IS SERVING, AND THAT IS A CONTROLLED PAIR RATHER THAN A NUMBER.** `SHIPPED` is a statement about
a commit, and a merged fix is not a shipped fix. Production answers the same URL with
`cf-cache-status: HIT` in **~54 ms** and, immediately after a purge, `MISS` in **~96 ms** - measured
back to back on 2026-09-17. The pair is the point: one absolute number cannot tell a warm edge from a
fast origin, and the ~42 ms between two fetches of identical bytes can only be the round trip that no
longer happens. **Do not quote it against the ~80 ms predicted from the user's own browser.** Same
order, different measurement - that one is an origin round trip seen from where the user sits, this
one from a workstation; neither confirms the other.

**AND THE HONEST CEILING IS ~80 ms, NOT A COLD START UNDER A SECOND.** Chrome's navigation split made
this look like the biggest term before the app speaks - TTFB 90-130 ms of a 162-323 ms pre-first-word
block, 56-60% of it - but Chrome was answering for `/login`, with no session and no MLS state, where
the 580 ms that dominate a real boot do not exist. On the user's line the same round trip is 94 ms of
a 1342 ms boot, **7%**. The reason to have done it is that it removes `frontend-ssr` from the critical
path of EVERY navigation rather than only of a boot.

**AND `no-store` DOES NOT COST THE BACK/FORWARD CACHE HERE, WHICH IS MEASURED AND NOT INHERITED.** The
standard argument for `no-cache` + an ETag over `no-store` is that `no-store` disqualifies a document
from the bfcache, so leaving the site and pressing Back pays the whole boot again. In this Chrome it
does not: a real history traversal away from `https://canari-emse.fr/login` and back fired `pageshow`
with `persisted: true`, the document's own JavaScript globals survived it, and
`performance.getEntriesByType('navigation')[0]` was still the ORIGINAL entry - all three the
signature of a restore, on the `no-store` response production served that day. So `no-cache` would
have bought the 6 KB body on a revalidation and nothing else; the round trip was always the cost.
**A later reader reaching for that argument should re-measure before believing it**, and the probe is
three steps: stamp `window`, traverse away, `history.back()`, read the stamp back.

**NOTHING HERE IS A LEAK**, which is worth stating because "the shell is per-user" is the first thing
a reader assumes and it is false. The app is a SPA with `ssr = false`; `hooks.server.ts` is the whole
of the server-side work and reads `event.url.pathname` and nothing else - no cookie, no session, no
user. Two fetches of `/chat` differ in exactly four lines, all of them Cloudflare's own injected
`__CF$cv$params`. An unauthenticated fetch already receives this document, so caching changes how
fresh it is, never who may read it.

## The daemon on the origin, and the token it carries

The tunnel is **remotely managed**: the ingress lives in the Cloudflare API, and the box holds only
the daemon (installed from Cloudflare's apt repository) and a systemd unit. The operating detail (which
hosts, the rotation runbook, recovery routes) is kept in the operators' private notes. Rules that
survive:

- **The run token must never be on a process command line.** `600` on the unit file closes
  `systemctl cat`, but `systemctl show -p ExecStart` reads systemd's in-memory state over D-Bus and
  answers any local user. Pass the token with `EnvironmentFile=` (a `600 root:root` file in a `700`
  directory), never `Environment=` (which `show` prints verbatim) and never `--token`. Verify against
  the mechanism that caused the leak, not against the question.
- **Never switch a daemon from a local config to `--token` without diffing the two:** the remote
  configuration may have been invisible while the local file was in effect, so the switch changes
  which configuration applies. A superseded local file is renamed, not left as `config.yml`.
- **A verification that cannot fail is not a verification:** assert a token fingerprint is non-empty
  before comparing it (the sha256 of the empty string equals itself).

### Rotating the run token, and the order that matters

The rotation is two API calls (reset the tunnel secret, read the new run token) and a unit change,
doable from a workstation with an account-scoped token. **Resetting the secret invalidates the old
token instantly, so the ability to read the new one must be proven BEFORE the reset**; a refusal
after the reset leaves a tunnel that looks healthy (the running daemon keeps its connections) and
dies silently at its next restart. A restart tears down the session that issues it when the tunnel is
the only door, so run it detached and leave a verdict in a log; a tunnel being up is not the site
being up. **A recovery route that has not been exercised is not a recovery route:** test it before
touching anything.

### Nothing keeps the daemon current, and a dormant timer says otherwise

`cloudflared service install` leaves an update timer that must not be enabled: it replaces the
binary in place and drifts it from what `dpkg` believes. Upgrade the package with apt, after checking
that no package owns the unit file carrying the token and comparing the token's fingerprint across
the upgrade.
## The tunnel drops in the 22h band, and nothing on this page can fix it

**Measured 2026-09-11.** Every hostname returned HTTP 530 / Cloudflare error **1033** for about six
minutes, on two different zones and machines. 1033 means the edge has **no connector registered** for
the tunnel: it is the edge reporting that the origin stopped answering IT, never a fault at the edge.
Nothing on the origin moved (containers, kernel, conntrack, NIC counters, journal all clean); the
connector logged `failed to dial to edge with quic: timeout`. **Do not restart the connector in
response to a 1033** - that destroys the evidence and repairs nothing.

The drops had a shape (every one in the 22h-23h band, tracking across two otherwise unrelated hosts),
and the only thing the two paths share is the School's border firewall, so the cause is upstream of
this repository and no request goes to the School's services (user, 2026-10-10). **Re-measured
2026-10-10, after the cutover: the band did not recur.** Re-read the connector's journal if a 1033 is
reported at night.

### Two refuted explanations, and the egress probe

**Do not re-open either refuted hypothesis.** (1) A hypervisor snapshot freezing the container: both
journals carried entries for every minute of the window, and the ledger gap was the probe's own
`AbortSignal.timeout` - a gap in a ledger is evidence about its WRITER before it is evidence about
the world ([durable-rules](../durable-rules.md)). (2) "The whole campus loses the network every
evening": zero events on three of the nights.

**The egress half.** `UpstreamUnreachableError` and `OUTBOUND_BUDGET_MS` are shipped; whether such
stalls are CORRELATED across boxes is read from
[`infrastructure/egress-probe/`](../../../infrastructure/egress-probe/README.md).

## A request body over 1 MiB is refused with a 413 on the legacy names - IT IS THE RELAY'S NGINX, NOT CLOUDFLARE (measured 2026-10-07, cause found 2026-10-09)

An unauthenticated `POST /api/media/upload` with a 1.2 MB body answered `413` with `Server: cloudflare`
on the legacy names while a 600 KB body reached the app. **The 413 page itself names the author**:
the body is nginx's own `413 Request Entity Too Large`, which Cloudflare only decorates. The limit is
nginx's DEFAULT `client_max_body_size 1m` on the relay that the legacy names cross; the current name
does not cross it and is not limited, and nothing downstream is (frontend nginx 100 MB, media-service
50 MB). The repair is a body-size limit and unbuffered request proxying in the relay's server blocks,
which are hand-written on the relay and not in this repository (owed to the user).

The client no longer retries a 413 (#1583, [chat](../frontend/modules/chat.md#a-413-ends-the-entry-2026-10-08)):
the entry ends with a visible notice. The client sends a media as ONE `POST /api/media/upload` and only
chunks above `CHUNK_SIZE = 50 MB` (`media.ts`). Dropping `CHUNK_SIZE` under 1 MiB to dodge a
one-line misconfiguration on a retiring relay is NOT recommended; the 301 on documents already moves
current clients to the current name.
## Working against the API

The account id and token are **not in this repository and must never be** - it is public. They are
held outside the repository and read inside each command rather than passed as arguments. An
account-scoped token (`cfat_` prefix) returns `Invalid API Token` from `/user/tokens/verify` while
working perfectly everywhere else - that endpoint is for user tokens only, so it is not a valid
check of the credential.

**Two agent tokens, and what each can actually reach** (measured 2026-09-29): the **user token**
reaches DNS, zone settings and Access but sees **no tunnel** and **no ruleset**; the **account token**
lists and edits the account's tunnels and their remote ingress configuration and lists rulesets, but
is REFUSED (`403`) on a zone's dynamic-redirect phase.

**Both were rotated on 2026-09-29** after their values reached a session transcript (a token can
rotate itself through its own value endpoint; verify the new one is `active` and the old one `401`).
Neither is a GitHub secret; CI carries its own, narrower tokens (`CLOUDFLARE_CACHE_PURGE_TOKEN`, the
Calls/TURN pair).
