# What Canari serves without an account

> Decided by the owner on 2026-11-02: *"Les informations qui sont voulues publiques sont celles sur
> https://portail-etu.emse.fr/, pas d'autres a priori. Si elles sont accessibles c'est un trou."*

**The public showcase is the ceiling.** A visitor with no Canari session may read what
portail-etu.emse.fr shows, and nothing more. One exception was chosen by the owner the same day: the
link preview of ONE shared association post. Everything else Canari answers without a session is
either a **capability** (a signed or unguessable link that a member handed out), a **liveness probe**,
or a **value about nobody** (a platform setting).

This page lists, route by route, what Canari serves to a visitor without an account BY INTENT, and
what was closed on 2026-11-02 when the rule was applied. The gates that hold it:

- `.github/scripts/tests/auth-request-coverage.test.mjs` - every route behind an `auth_request`
  location is authorized or declared in `PUBLIC_BY_INTENT` with a reason; `CLOSED_TO_ANONYMOUS`
  names the routes closed on 2026-11-02 and fails if one answers anybody again.
- `apps/social-service/src/public/anonymous-surface-closed.spec.ts` - the session guard on each
  route closed that day, read from Nest's own metadata.
- `apps/social-service/src/public/public.controller.spec.ts` - the public controller serves no
  listing of posts; the member photo relay.
- `frontend/src/lib/seo/serverSeo.test.ts` and `frontend/src/routes/sitemap.xml/sitemap.server.test.ts`
  - the server-rendered head and the sitemap.

`auth_request` identifies and never refuses (see the head of the coverage gate), so the service's
own guard is the only thing that closes a route.

## What the showcase shows (the reference)

Read from the portail-etu repository on 2026-11-02. It has no login at all; every page is public.

| Page | What it shows |
|---|---|
| `/`, `/associations` | every association: name, logo, colour, description, member count, archived badge; the published "Carte de la Vie Asso" |
| `/lists` | every promo list: name, logo, parent association, promo, member count |
| `/associations/<slug>`, `/lists/<slug>` | the entity (name, second name, logos, colour, description, bio, promo, BDE badge, contact email) and its **roster**: each member's name, role, promo, photo, board or not |
| the carte | per association: logo, name, contact email, the president and bureau cards (name, role, photo) and a directory of rosters |
| `/liens`, `/confidentialite`, `/mentions-legales`, `/sitemap.xml` | static text; the sitemap lists association slugs |

It shows **no** events or agenda, posts, profiles, shop, forms, categories or photos beyond the
roster's.

## Canari's anonymous surface, route by route

**Closed** = a session is now required. **Kept** = public by intent, with the reason.

### Data routes (social-service, core-service)

| Route | Verdict | Why |
|---|---|---|
| `GET /api/associations/users/:userId/memberships` | **closed** | a person's profile; the showcase has none |
| `GET /api/associations/users/:userId/role-history` | **closed** | same |
| `GET /api/associations/:id/products` | **closed** | the shop; the showcase has none |
| `GET /api/associations/categories` | **closed** | a legacy shim answering `[]` since migration 147 replaced the global categories by per-map zones; the showcase never read it |
| `GET /api/forms/:id/calendar-link` | **closed** | an agenda entry; the showcase has no agenda |
| `GET /api/public/posts` (the 500 newest association posts) | **closed (owner 2026-11-02)** - the route is gone | a feed, not a link preview; its one consumer, the sitemap, lists no post any more |
| `GET /api/public/associations`, `.../slug/:slug` | kept | the showcase's own source: exactly its entity fields. `?space=<formation>:<campus>` (owner, 2026-11-08) keeps only the entities whose audience reaches that space - for associations the carte's set plus that space's archived ones, which the portail lists in its archived section (`spaces/public-space.ts`) - and 404s another space's page; **lists and institutions are filtered the same way since 2026-11-14** (owner: "Filtrer comme les assos"). Without it the complete list, unchanged: Canari's own sitemap and SEO read it - and so did the portail's directory until its `v1.0.9`, which only named its space for the carte (measured 2026-11-14: 50 associations served where `ICM:saint-etienne` offers 47) |
| `GET /api/public/associations/slug/:slug` (its `members`), `GET /api/public/associations/:id/members` | kept | the showcase's roster: name, role, promo, board flag, and the photo as `avatarUrl` |
| `GET /api/public/members/:memberId/avatar` | kept (new) | the roster's photo, reached through the roster row rather than the account: exactly as public as the roster line that lists it, gone when the member leaves. Bodyless on every miss, and unthrottled: the showcase hands `avatarUrl` to the visitor's browser, which asks for every face a carte or a roster draws (a hundred and more), so the default bucket (20 a minute per address, per replica) would turn one carte render into initials. A request costs a uuid check, a primary-key read and one internal hop; core's avatar cache, keyed by account, bounds what reaches the photo provider; the comparable public routes (core's avatar route, `/api/media/public/:id`) are unthrottled too |
| `GET /api/public/carte?space=<formation>:<campus>` | kept | the showcase's carte for the space it names ([carte](carte-vie-asso.md#rules)); each card carries `avatarUrl` like a roster member. Without `space` a legacy shim, served only while exactly one map is live ([legacy-compatibility](legacy-compatibility.md)) |
| `GET /api/public/posts/:id/preview`, `/preview-image` | **kept - owner decision** | the link preview of one shared association post |
| `GET /api/public/forms/:id`, `POST .../submit`, `POST .../receipts/confirm` | kept - capability | a form its association chose to make public, answered by a guest on its shared link; the reply is an allowlist naming no owner and no association ([forms](frontend/modules/forms.md#a-public-form-is-answered-without-an-account-2026-09-30)) |
| `GET /api/public/cotisant-status` | kept - not anonymous | Le Cercle's server-to-server check, refused without its API key |
| `GET /api/external/profile/:sub` | kept - not anonymous | Sky's server-to-server read, refused without its API key |
| `GET /api/bookings/:bookingId/calendar.ics` | kept - capability | an HMAC bound to one of the booking's people |
| `GET /api/media/public/:id` | kept - capability | association logos and group/community pictures, by unguessable id |
| `GET /api/media/public/live/...` | kept | ciphertext under a key only a viewer is handed |
| `GET /api/users/:id/avatar` | kept | an `<img>` subresource; its access model is in [core-service](services/core-service.md#the-avatar-proxy) |
| `GET /api/payments/provider`, `GET /api/media/limits` | kept - about nobody | platform settings (`lydia`/`disabled`, the upload ceiling) |
| `POST /api/payments/lydia-*` | kept | Lydia's callbacks; they return nothing about anybody |
| `/api/auth/*` | kept | the sign-in, refresh, logout and restore flows; every session route needs the token |
| `GET /api/version`, the health routes | kept | probes |

### The server-rendered head, the sitemap and robots (frontend-ssr)

The head is written into every page served to anybody, crawlers and link unfurlers included, so it
is part of the anonymous surface.

| Path | Verdict | Why |
|---|---|---|
| `/profile/<id>` head | **closed** | it named the person (name, promo, formation); now the generic head, no service asked |
| `/calendar` head (`ItemList` of `Event`) | **closed** | it listed 25 upcoming events with their text, image and organiser; now the site nodes only |
| `/sitemap.xml` posts | **closed (owner 2026-11-02)** | the sitemap lists static pages and association slugs, as the showcase's does |
| `/associations/<slug>` head | kept | the showcase's fields (name, description, logo, contact email, member count) |
| `/posts/<id>` head | **kept - owner decision** | the shared post's link preview |
| `/c/join/<token>`, `/g/join/<token>` heads | kept - capability | an invite a member handed out; `noindex` |
| `/forms/<id>` head | kept | reads a guarded route and so only ever gets the generic head |

The app itself renders nothing for a signed-out visitor beyond `/login`, `/auth`, `/legal` and a
public form's `/f/` page (`isSignedOutPath`), so it was never a consumer of the routes closed here.

## Consumers checked

- **portail-etu**: reads `/api/public/associations*` and `/api/public/carte`; every field it reads
  is still served, and `avatarUrl` is added beside them.
- **The signed-in app and the native apps**: every closed route is called with the session.
- **The sitemap, the head injector**: changed above.
- **Le Cercle, Sky**: API-key routes, unchanged.

## The `avatarUrl` contract

`avatarUrl` (on a public roster member and on a carte card) is an **absolute URL on Canari's public
origin** - the first entry of `FRONTEND_URL`, as every link this service writes for somebody else
(`common/frontend-url.ts`). A consumer on another origin uses it as it is, with no prefix. It
answers the image (with an ETag), a 304, or a bodyless 404 when there is no photo.
