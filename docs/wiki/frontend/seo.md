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

### Where the data comes from

`src/lib/seo/serverSeo.ts` starts from `resolveSeoForPath()` — the same baseline the client uses —
and enriches it per path shape. Every call goes **direct over the Docker network**, never back
through nginx, with `X-Internal-Secret` (never `X-Internal-Token`, which is bound to a user id and
would be impersonation). One seam: `src/lib/seo/internalApi.ts`, shared with the sitemap.

| Path | Source | Structured data |
|---|---|---|
| `/posts/{id}` | social-service `GET /api/posts/:id` | `Article` + `BreadcrumbList` |
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
- recent posts from **`feed=associations`**, not `feed=all`. Both are readable without a session,
  but submitting a URL to a search engine is not the same act as not blocking it: an association's
  post is a communication its authors want found, a student's personal post is not something to put
  in front of a search engine on their behalf.

Both halves run in parallel and are allowed to come back empty — a short sitemap is worth serving,
a 500 is not.

`/robots.txt` stays prerendered (it has no data to fetch) and disallows every private prefix, the
invite tokens, and `/app-shell`.

## When the SSR container is down

`adapter-node` emits no `index.html`, so nginx had nothing to answer with: a dead `frontend-ssr`
meant a 502 on *every* navigation — the whole site, to spare a `<head>`. `routes/app-shell/` is
prerendered into `build/prerendered/app-shell.html`: a plain shell that boots the SPA on whatever
URL was requested (`kit.start(app, element)` with no route data, exactly like the static build's
fallback). nginx serves it from `@app_shell` on 502/503/504.

**There is deliberately no `=` on that `error_page`**, so the 5xx status is preserved while the body
is the shell. A browser runs the scripts of a 5xx body, so a person gets a working app; a crawler
gets a status it will retry, rather than a 200 carrying `noindex` — which is a request to *deindex*
the page. See [../infrastructure/nginx.md](../infrastructure/nginx.md).

## Related

- [architecture.md](architecture.md) — the two adapters and the build polarity
- [../infrastructure/nginx.md](../infrastructure/nginx.md) — the locations and the fallback
- [../services/chat-delivery.md](../services/chat-delivery.md) — outbound link previews (the other
  direction: how Canari renders *someone else's* page)
