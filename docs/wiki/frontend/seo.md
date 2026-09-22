# SEO and link previews

**Source**: `frontend/src/lib/seo/`, `frontend/src/hooks.server.ts`, `frontend/src/routes/sitemap.xml/`, `frontend/src/routes/robots.txt/`

## The constraint everything here follows from

Canari is a SPA (`export const ssr = false`) whose content sits behind a login. That produces one
hard fact, and every decision on this page is a consequence of it:

> **A crawler sees no content.** Googlebot does execute JavaScript, but it crawls as an anonymous
> visitor — so what it renders is the sign-in screen. Not a thin page: an empty one.

So the `<head>` the server writes is not an enhancement on top of indexable content. It **is** the
indexable surface of the site. Same for an unfurler (Discord, Slack, WhatsApp), which does not even
run the JavaScript.

Two things follow:

1. Anything a search engine should know must be in the head — including the content itself, which
   is why the JSON-LD below carries real titles, descriptions, dates and authors.
2. Nothing links to anything. A crawler cannot walk from `/associations` to `/associations/bde`,
   because that link only exists after hydration. **The sitemap is the entire link graph.**

## The head, written per request

`src/hooks.server.ts` substitutes two literal markers in `src/app.html` via `transformPageChunk` —
which fires even with `ssr = false`, since it operates on the shell, not on a render.

| Marker | Replaced by |
|---|---|
| `<title>Canari</title>` | `renderSeoTitle(meta)` |
| `<!--canari-seo-->` | `renderSeoTags(meta, pathname)` |

`renderHead.test.ts` asserts both literals still exist in `app.html`. Nothing type-checks a string
substitution, so a renamed marker would turn the whole feature into a silent no-op.

### One thing names a page, and one list says whether it is public

`resolveSeoForPath()` answers for **every** path, and both halves of that were false until
2026-09-14.

**Twenty of the forty static routes had no name.** They fell through to `SITE.defaultTitle`, so
thirteen admin pages, `/settings`, `/profile`, `/events`, `/directory`, `/lists`, `/documents` and
`/account/purchases` all opened a tab reading "Canari - Mines Saint-Etienne". Ten OTHER pages had
each worked around that by rendering a `<svelte:head><title>` of their own - which WINS over the one
`SeoHead` renders, while `og:title` and `twitter:title` keep the layout's. So a page that fixed its
own title broke its own preview: `/legal/cgu` served a document titled "Conditions Generales
d'Utilisation" whose `og:title` said "Conditions generales d'utilisation", because the two spellings
lived in two files that had drifted.

`PAGE_TITLES` in `resolve.ts` is now the one owner, and every entry is a reference to the message
the page already displays as its heading - so a page's name exists exactly once in the app. Admin
pages compose `seo_admin_page_title` over the section name, because `/admin/associations` and
`/associations` otherwise read identically in a tab.

**"Not for the public" was three lists that disagreed.** `PRIVATE_PREFIXES` here, the `Disallow:`
block in `routes/robots.txt/+server.ts`, and `PUBLIC_SITEMAP_ENTRIES`. robots spelled `/profile/`
and `/admin/` with a trailing slash, which leaves `/profile` and `/admin` themselves crawlable;
neither list had heard of `/directory`, the student directory. `PRIVATE_PREFIXES` is now the single
source and robots writes its `Disallow:` lines from it. `/api/` is the one line robots still states
itself, because it is not a page.

`seoTitles.test.ts` holds all of it, against the **derived** route set so a page added tomorrow is
asked the same question: every static route resolves a title that is not the default (`/` and
`/app-shell` excepted, each with the sentence saying why), no `.svelte` file but `SeoHead` renders a
`<title>`, and nothing is in both the sitemap and the private list.

### Where the data comes from

`src/lib/seo/serverSeo.ts` starts from `resolveSeoForPath()` — the same baseline the client uses —
and enriches it per path shape. Every call goes **direct over the Docker network**, never back
through nginx, with `X-Internal-Secret` (never `X-Internal-Token`, which is bound to a user id and
would be impersonation). One seam: `src/lib/seo/internalApi.ts`, shared with the sitemap.

| Path | Source | Structured data |
|---|---|---|
| `/posts/{id}` | social-service `GET /api/public/posts/:id/preview` | `Article` + `BreadcrumbList` |
| `/associations/{slug}` | social-service `GET /api/public/associations/slug/:slug` | `Organization` + `BreadcrumbList` |
| `/forms/{id}` | social-service `GET /api/forms/:id` | — |
| `/profile/{id}` | core-service internal public-profile | — |
| `/c/join/{token}` | social-service internal invite preview | — (`noindex`) |
| `/g/join/{token}` | chat-delivery internal invite preview | — (`noindex`) |
| `/`, `/posts` | — | `Organization` + `WebSite` |
| `/associations` | — | site nodes + `BreadcrumbList` |
| `/calendar` | social-service `GET /api/associations/calendar/feed` | `ItemList` of `Event` |

Each is best-effort behind a 1.5 s timeout, with a 60 s LRU in front (one shared link produces a
burst of unfurler hits on one path). **A failure degrades the preview; it never fails the page** —
the page is the app.

**A path a real page owns is never an id.** The table above is matched with a REGEX, which is not
how SvelteKit routes - there a literal segment always beats a parameterised sibling, so
`/forms/success` is the post-payment page and not the form whose id is `success`. A regex has no
such rule, and four real pages were being handed to an enricher as an id: `/forms/success`,
`/forms/cancel`, `/forms/create` and `/associations/new`. The first three reached Postgres as a
`uuid`, so social-service answered **500 once per completed payment** (measured on prod
2026-08-27), silently, because a failed enrichment only degrades the preview.

`src/lib/seo/staticRoutes.ts` carries that precedence rule. Its set of static paths is **derived**
from the route tree with `import.meta.glob` at build time, not listed, so a new static route joins
it by existing and the rule cannot rot. It is a separate module because `serverSeo.ts` reaches
`internalApi.ts` and therefore `$env/dynamic/private`, which no test can import - the same reason
`sitemap.ts` stands alone. `staticRoutes.test.ts` pins the four collisions, which nothing else
states now that the set is derived.

**`og:image` must be built from the site origin.** `associationLogoSrc()` falls back to
`http://localhost:3011` when `window` is undefined — which is exactly the SSR case, so using it here
would advertise a localhost URL to every unfurler. The absolute URL is composed from the request's
own origin instead.

### A shared post, and the ten days it previewed as nothing

Until 2026-09-20 the post enricher called `GET /api/posts/:id`, and **on production it had never
once succeeded**. `FeedAudienceGuard` shipped on 2026-09-10 and closed that route to every caller
without an ICM session — correctly; the social feed is not public. The head injector has no session
either. Measured in `frontend-ssr`'s own log on 2026-09-20: **22 `[SEO] .../api/posts/<id> answered
401` lines in 72 hours**, and `sitemap: 8 static + 75 associations + 0 posts` on every single build.
Nothing was red, because both consumers fail soft on purpose — a failed enrichment degrades a
preview and an empty list is a short sitemap. So every post link shared into WhatsApp, Discord or a
timeline rendered `Publication - Canari`, the site logo and one generic sentence, and the site
advertised no post at all to any crawler.

**The gate was not widened. A narrower door was opened beside it.**
`PostPreviewService` (social-service, `src/posts/post-preview.service.ts`) answers for
**association posts only** — the line the sitemap already drew, for the same reason: an
association's post is a communication its authors want carried, a student's personal post is not
something to hand to whoever holds a URL. A personal post still gets the generic card, deliberately.

It is **one predicate**, `findShareable`, and the JSON preview, the image bytes and the sitemap list
all go through it. It refuses a post with no `associationId`, a `hiddenByModeration` post, a post
scheduled for later, and one whose association is archived. **Every refusal is the same 404 as a
post that does not exist**: spelling them apart would turn a guessed id into a way to ask whether a
hidden post exists. Reactions, comments, poll results, mentions and the author's user id are not in
the payload at all — the cheapest way not to leak a field is not to select it.

| Route | What it serves |
|---|---|
| `GET /api/public/posts/:id/preview` | text, association, image dimensions — `Cache-Control: max-age=300` |
| `GET /api/public/posts/:id/preview-image` | the decrypted first image — `max-age=3600`, **ThrottlerGuard** |
| `GET /api/public/posts?limit=` | ids + `updatedAt` for the sitemap, capped at 500 |

### The image an unfurler can actually fetch

A post's photos are encrypted at rest: each `posts.images` entry carries `mediaId`, `key` and `iv`,
and the client decrypts in the browser. **An unfurler has no session and no key, so `og:image` could
never point at `/api/media/:id`** — which is why the card used to fall back to the association's
200px crest even for an album of twelve photos, and the crest is the half of a card that decides
whether anybody clicks.

The key lives in the post row and media-service has never held it, so the decrypt happens in
social-service: it fetches the ciphertext from `GET /api/media/internal/:id` with `X-Internal-Secret`
and decrypts it there. **This cannot be one more `/api/media/public/:id`** — the blob is not public, the
*decision* to publish it is, and that decision is a property of the post.


#### THE `/api` PREFIX IS NOT IN THE ENVIRONMENT VARIABLE, AND THAT COST THE WHOLE FEATURE (2026-09-22)

**This page said `/media/internal/:id` and so did the code, for two days, and not one post preview
image ever loaded in production.** `MEDIA_SERVICE_URL` names the container; media-service mounts
every controller under `setGlobalPrefix('api')`. Express answered its own `Cannot GET` 404, which
social-service logged as `preview image <id> answered 404` - **a sentence that reads as "the object
is missing"**, sending every reader to the object store, where the blob was intact. The upload log
for the same id, three minutes earlier, read `Stored encrypted blob: <id> (543364 bytes)`.

Measured on production 2026-09-22, on the probes that separate the causes:

| probe | answer |
|---|---|
| association posts with an image, `preview-image` fetched as `facebookexternalhit` | **11 of 11 -> 404** |
| `og:image` and its declared dimensions, served to that crawler | correct, `1080x1350` |
| `http://media-service:3011/media/internal/<id>` from inside social-service | **404**, `text/html`, `Cannot GET` |
| `http://media-service:3011/api/media/internal/<id>`, same call, same secret | **200**, `application/octet-stream`, 543 364 bytes |

So every association post shared into an unfurler since the feature shipped drew a **blank box at
the declared 1080x1350** - a reserved box being exactly what declaring the dimensions guarantees.
The card's text half worked throughout, which is why it read as a rendering quirk rather than a
dead route.

**The fix is not the four missing characters, and the seam for it already existed.**
`apps/social-service/src/internal/service-urls.ts` was written in August for exactly this class -
three callers in this service had already addressed chat-delivery-service without its prefix - but
it only ever offered `deliveryUrl`, so media-service stayed every caller's to address.
`AssociationsService` spelled `/api/media/...` correctly at both its call sites and
`PostPreviewService` did not at its one, which is what kept it invisible: **a convention applied in
two places out of three is the worst state a convention can be in.** `mediaUrl` now sits beside
`deliveryUrl`, `service-urls.spec.ts` fails if any production source names an internal base URL
again, and `post-preview.service.spec.ts` pins the URL the preview actually requests - **every
refusal on that path had been asserted, and the happy path's one outbound call had not.** The
warning also names the URL now, because a status alone credits the wrong author for a 404.

Two details that are the whole difference between this working and failing:

- **WebCrypto appends the 16-byte GCM tag to the ciphertext; Node's `createDecipheriv` wants it
  handed to `setAuthTag` separately.** `decryptPostMedia` splits them, and
  `post-preview.service.spec.ts` reproduces the client's output byte for byte rather than asserting
  that AES works.
- **The key and IV are hex**, matching `frontend/src/lib/mediaCrypto.ts` — stated in exactly those
  two places and nowhere in between.

An image over **5 MB is not offered at all** and the card falls back to the logo: Twitter refuses one
that size outright and then shows *no* card, which is worse. The client compresses a post image to
2048px at 0.92 (`IMAGE_COMPRESS_PRESETS.post`), so the ceiling is far above anything the app
produces; it exists for rows that predate that preset.

**`og:image:width`/`height` are declared only where both are known, and both or neither.** An
unfurler reserves that box before the bytes arrive, so a guessed pair renders a gap the image never
fills, and a lone width describes nothing. The site image's dimensions are constants and a post's
photo carries its own; an association logo declares none. `renderHead.ts` and `SeoHead.svelte`
compute the identical pair — they are meant to be comparable line by line, so a tag added to one is
owed to the other.

### The two invite links

Both already had their own session-free preview endpoint and both are `noindex` — previewing for
whoever holds the link is the point, being listed in a search index is not. Two things changed on
2026-09-20: the descriptions became sentences somebody might act on, and **the group invite got an
image**. It had none for no reason other than `resolveGroupInvitePreview` not selecting the column,
while the community invite beside it carried one; a group avatar is a raw public blob
(`/api/media/public/:id`), exactly like a community image, so an unfurler can fetch it.

All four strings go through Paraglide (`seo_community_invite_*`, `seo_group_invite_*`,
`seo_invite_image_alt`) rather than being French literals in a `.ts`.

### Escaping is the security-critical part

Post text, association names and event titles are user-supplied and land in the shell of every
visitor. Two different escapes, because the two contexts are different:

- **HTML attributes** — `escapeHtmlAttribute()` escapes `& < > " ' \``. Applied to every
  interpolation, without exception.
- **JSON-LD** — `serializeJsonLd()` escapes `<` as `\u003c` and `&` as `\u0026`. `JSON.stringify`
  leaves `</script>` byte-for-byte intact, and inside a script element that sequence *ends the
  element*: everything after it parses as markup. A post title alone would be an injection point.

## Hydration must not undo the server's work

`SeoHead.svelte` removes every `[data-canari-seo]` node on mount and emits its own — otherwise the
document carries two of each tag. But a route `load` runs in the browser with no access to the
services, so on its own it can only produce the slug and a generic sentence for
`/associations/bde`. An unfurler never hydrates, so it would not notice; **Googlebot does**, and it
would index the downgrade.

So the injected block ends with the resolved metadata as JSON:

```html
<script type="application/json" id="canari-seo-data" data-canari-seo>{"path":"/associations/bde","meta":{…}}</script>
```

`injectedSeo.ts` reads it **once** (memoised — `SeoHead` deletes the element on mount) and
`SeoHead` merges it with the highest precedence, but only when its `path` matches the current
pathname. It carries the *requested* path, not the canonical one: `/` canonicalises to `/posts`, so
keying on the canonical path would stop the client ever recognising its own payload. After one
client-side navigation it no longer applies, which is the intent.

## Structured data

`src/lib/seo/jsonLd.ts`. The site is named "Canari", which is also a bird — that word cannot be won
on its own. What disambiguates it is being consistently attached to an institution Google already
knows, by name, URL and postal address. So `institutionNode()` (Mines Saint-Étienne) hangs off
every graph: `parentOrganization` on the site, `memberOf` on each association.

- One `Organization` node is *referenced* by `@id`, never duplicated — two nodes with one name is
  how a graph ends up describing two organisations.
- `WebSite.potentialAction` declares the search entry point a sitelinks search box is built from.
- `Event` is the one type here with a real chance of a rich result (Google renders events with
  their dates), and an agenda is exactly what a student searches for. Every event declares
  `location`, because Google's event guidelines warn on a missing one.
- `prune()` drops undefined values: a declared-but-empty property is reported as malformed.

## Sitemap and robots

`/sitemap.xml` is **built per request** (`prerender = false`), because a static list of eight paths
tells a crawler nothing about the content. It merges the static routes with:

- every non-archived association, via the public projection;
- recent **association** posts, via `GET /api/public/posts` — not every post. Submitting a URL to a
  search engine is not the same act as not blocking it: an association's post is a communication
  its authors want found, a student's personal post is not something to put in front of a search
  engine on their behalf.

This read used to be `/api/posts?feed=associations`, and the docblock beside it asserted that feed
was "readable without a session". **That sentence was true when it was written and false from
2026-09-10**, and nothing re-read it — see the section above for what it cost. A claim about who may
read something rots wherever it is not the code doing the enforcing, so the rule now lives in SQL on
the service that owns posts and both consumers read that one surface.

Both halves run in parallel and are allowed to come back empty — a short sitemap is worth serving,
a 500 is not.

`/robots.txt` stays prerendered (it has no data to fetch) and **writes its `Disallow:` block from
`PRIVATE_PREFIXES`** rather than restating it - see the section above for what the second copy cost.
The `Allow:` lines mirror the sitemap, and `seoTitles.test.ts` asserts no path is in both.

## When the SSR container is down

`adapter-node` emits no `index.html`, so nginx had nothing to answer with: a dead `frontend-ssr`
meant a 502 on *every* navigation — the whole site, to spare a `<head>`. `routes/app-shell/` is
prerendered into `build/prerendered/app-shell.html`: a plain shell that boots the SPA on whatever
URL was requested (`kit.start(app, element)` with no route data, exactly like the static build's
fallback). nginx serves it from `@app_shell` on 502/503/504. **Its asset paths have to be absolute, which is why the web build sets `paths.relative: false`** - a page served on a URL it does not own cannot resolve `./_app/...`; see [nginx](../infrastructure/nginx.md#when-frontend-ssr-is-down-app_shell).

That `error_page` carries **`=200`**, and the reasoning went the other way first. Preserving the 5xx
is better for a crawler (a status it retries, rather than a 200 whose head is the generic one), and
a browser runs the scripts of a 5xx body anyway — but Cloudflare *replaces* the body of an origin
5xx with its own plain-text page, so the shell never reaches anyone. What is indexed during an
outage is the site's default head, which the next crawl repairs; what a 5xx costs is the site. See
[../infrastructure/nginx.md](../infrastructure/nginx.md).

## What no test here can prove

Everything above is covered by unit tests and was probed against the built server with a stub
social-service. Four things still need a human, after a deploy, and none of them is a code task:

1. **Paste a real link into Discord, Slack and WhatsApp.** An association post **that has a photo**,
   a personal post (which must still show the generic card), a `/c/join/{token}` and a
   `/g/join/{token}`. Their unfurlers are the actual consumers, they are not curl, and the photo
   path is the one that crosses three services — head injector, social-service, media-service — so
   it is the one a missing `INTERNAL_SECRET` silently reduces back to a logo.
2. **Install the Android build and confirm it still boots.** The adapter split means the mobile
   build now goes down a different branch of `svelte.config.js` than the web one.
3. **Run an association page and the agenda through Google's Rich Results Test.** The JSON-LD is
   verified by our tests, never by Google's own parser.
4. **Submit `/sitemap.xml` in Search Console**, then read the coverage report a few days later.

**The deploy is the risk to watch, not the code.** `INTERNAL_SECRET` has to reach `frontend-ssr` or
every preview silently degrades to the generic one (recorded in `infrastructure/MIGRATION.md`). A
dead `frontend-ssr` no longer takes the site down — nginx serves the prerendered shell — but it does
cost every head, so `X-Canari-Degraded: ssr-unavailable` in the access log is the thing to grep for.

### THE PHOTO PATH, MEASURED ON PRODUCTION EITHER SIDE OF v0.18.19 (2026-09-22)

The user reported it the way an unfurler shows it: a Messenger card with an empty image box. The
probe is public and needs no credential - list `/api/public/posts`, ask each one's `/preview`
whether it claims an image, then fetch `/preview-image` for those that do.

| | posts claiming an image | image served | blank |
|---|---|---|---|
| production on `v0.18.18`, before | 10 | **0** | 10 |
| production on `v0.18.19`, after | 10 | **10** | 0 |

Served bodies ran 73 kB to 868 kB, and a fetch as `facebookexternalhit/1.1` found `og:image` on 12
of 12 share pages, so the tag an unfurler actually reads points at bytes that arrive. Use a
cache-busting query when re-running this: the 200 path sets `max-age=3600` at the edge, and a stale
404 would answer for the deploy rather than about it.

**AND THE WARNING TWO PARAGRAPHS UP HAD ALREADY NAMED THIS FAILURE - against the wrong service.** It
says a missing `INTERNAL_SECRET` reduces the photo path back to a logo, and it says to check
`frontend-ssr`. On dev, `frontend-ssr` had the secret; `social-service` - the second of the three
services this page itself lists as being on that path - had never been passed it at all, so the
route answered `403` and no photo could have rendered whatever else was true. **A hazard written
down against one service on a path does not cover the path.** Every deployed estate is now held to
production's key set by `compose-wiring.test.sh`
([dev-environment](../infrastructure/dev-environment.md#the-consequence-nobody-had-written-down-a-media-path-cannot-be-rehearsed-here-2026-09-22)).

## Related

- [architecture.md](architecture.md) — the two adapters and the build polarity
- [../infrastructure/nginx.md](../infrastructure/nginx.md) — the locations and the fallback
- [../services/chat-delivery.md](../services/chat-delivery.md) — outbound link previews (the other
  direction: how Canari renders *someone else's* page)

### The same method, in the three sibling repos (all shipped and verified on prod 2026-08-19)

Each carries its own `docs/wiki/seo.md`. They share `serializeJsonLd`'s escaping, the
absolute-URL-from-the-request-origin rule, and the position that a head is only worth writing if the
SERVER writes it — duplicated on purpose, four times, with nothing shared between the repos.

| Repo | What its head is FOR | What was wrong |
|---|---|---|
| **Portail-etu** | The only genuinely public site in the ecosystem: search AND unfurl | `ssr = false`, so every page shipped an empty head; `robots.txt` advertised a `/sitemap.xml` that 404ed, and the detail pages were linked only from markup that did not exist until hydration — uncrawlable by construction |
| **Sky** | One public landing page; the rest is behind an ICM session | `<title>` and nothing else, so every share was a bare URL. Now `noindex` on `/unauthorized`, and no sitemap — one indexable page is not a link graph |
| **MiGallery** | Unfurlers ONLY (`robots.txt` is `Disallow: /`, permanently) | The album card was Open Graph with no `twitter:card`, no `og:url`, no canonical; the gallery root had no card at all |

Two rules came out of doing all three that are not obvious from any one of them. **An unfurler is
not a crawler** — it fetches the URL it was given and never reads `robots.txt`, which is why a site
that refuses every crawler still needs a complete head. And **a `Sitemap:` line pointing at a path
that does not answer is worse than none**: a crawler following it does not fall back to guessing.
