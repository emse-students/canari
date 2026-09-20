import {
  CORE_URL,
  DELIVERY_URL,
  SOCIAL_URL,
  fetchJson,
  internalHeaders,
} from '$lib/seo/internalApi';
import {
  buildArticleJsonLd,
  buildAssociationJsonLd,
  buildBreadcrumbJsonLd,
  buildEventJsonLd,
  buildEventListJsonLd,
  buildSiteJsonLd,
  type JsonLdNode,
} from '$lib/seo/jsonLd';
import { m } from '$lib/paraglide/messages';
import { mergeSeo, resolveSeoForPath } from '$lib/seo/resolve';
import { isStaticPageRoute, normalizePath } from '$lib/seo/staticRoutes';
import { SITE, siteOrigin } from '$lib/seo/site';
import { markdownToPlainText, truncateForMeta } from '$lib/seo/text';
import type { SeoMeta } from '$lib/seo/types';

/**
 * Per-path Open Graph metadata and structured data, resolved on the server.
 *
 * The app is a SPA (`ssr = false`), so no component runs here - only this module does. It exists
 * because an unfurler or a crawler never executes the client, and therefore never sees a single
 * tag `SeoHead.svelte` emits: without it, every shared Canari link previews as the bare shell
 * title. It reads the SAME `resolveSeoForPath` the client uses as its baseline and only enriches
 * it with what needs a round trip.
 *
 * For a SEARCH engine the stake is larger than a preview. Googlebot does render JavaScript, but it
 * renders as an anonymous visitor - which on this site means the login screen - so the rendered DOM
 * carries no content whatsoever. The head written here, and the JSON-LD in it, is therefore the
 * entire indexable surface of the site. That is why each enricher also builds schema.org nodes
 * rather than stopping at og:title.
 *
 * Every fetch here is best-effort. A slow or broken service degrades the preview to the generic
 * per-kind text; it must never fail the page, which is the app itself.
 */

/**
 * Cache of rendered metadata, keyed by pathname. One shared link produces a burst - several
 * unfurlers, retries, and the crawlers behind them - all asking for the same path within seconds.
 * Short-lived on purpose: an edited post should not keep previewing its old title for long.
 */
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;
const cache = new Map<string, { meta: SeoMeta; expiresAt: number }>();

function cacheGet(path: string): SeoMeta | null {
  const hit = cache.get(path);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(path);
    return null;
  }
  return hit.meta;
}

function cachePut(path: string, meta: SeoMeta): SeoMeta {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(path, { meta, expiresAt: Date.now() + CACHE_TTL_MS });
  return meta;
}

/** Absolute canonical URL for a pathname. */
function pageUrl(path: string): string {
  return `${siteOrigin()}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Absolute URL for a media-service public asset. Built from `siteOrigin()` rather than through
 * `associationLogoSrc`, whose base falls back to `http://localhost:3011` when `window` is
 * undefined - which is precisely this process, and an unfurler cannot fetch that.
 */
function publicMediaUrl(pathOrUrl: string | null | undefined): string | undefined {
  const value = pathOrUrl?.trim();
  if (!value) return undefined;
  if (value.startsWith('http')) return value;
  return `${siteOrigin()}${value.startsWith('/') ? value : `/${value}`}`;
}

interface PostPreviewPayload {
  markdown?: string;
  createdAt?: string;
  updatedAt?: string;
  association?: { name?: string; slug?: string; logoUrl?: string | null } | null;
  /** Present, with the stored dimensions, when the post carries an image worth showing. */
  image?: { width?: number | null; height?: number | null } | null;
}

/**
 * THE POST ENRICHER, AND WHY IT NO LONGER ASKS `/api/posts/:id`.
 *
 * It did, from the day this file was written until 2026-09-20, and on production it never once got
 * an answer: `FeedAudienceGuard` shipped on 2026-09-10 and that route has refused every
 * session-less caller since - **22 `answered 401` lines in 72 hours of `frontend-ssr` log**. The
 * fallback is silent by design (a failed enrichment degrades a preview, it never fails a page), so
 * every post link shared outside Canari previewed as `Publication - Canari` with the site logo,
 * and nothing said so.
 *
 * `/api/public/posts/:id/preview` is the door built beside that gate rather than through it. It
 * answers for ASSOCIATION posts only - see `PostPreviewService` in social-service, which owns that
 * rule - so a student's personal post still gets the generic card, deliberately. No secret is sent
 * with this call and none is needed: the endpoint is public because what it returns is.
 */
async function postSeo(postId: string, path: string): Promise<Partial<SeoMeta> | null> {
  const post = await fetchJson<PostPreviewPayload>(
    `${SOCIAL_URL()}/api/public/posts/${encodeURIComponent(postId)}/preview`
  );
  if (!post) return null;

  const plain = markdownToPlainText(post.markdown ?? '');
  const author = post.association?.name?.trim() || null;

  // The title is the post's opening words, and the association's name when it has none - a photo
  // post used to title itself "Publication", which is the word the whole feed shares.
  const title = plain
    ? truncateForMeta(plain, 70)
    : author
      ? m.seo_post_title_from({ association: author })
      : SITE.name;
  // An author line in front of the description is the only place the card says WHO posted without
  // spending the title on it.
  const description = plain
    ? truncateForMeta(author ? m.seo_post_byline({ author, text: plain }) : plain, 200)
    : author
      ? m.seo_post_description_fallback({ association: author })
      : `${SITE.name}.`;

  // THE POST'S OWN PHOTO FIRST, AND THE LOGO ONLY WHEN THERE IS NONE. The logo was the only thing
  // this ever offered, so an album of twelve photos unfurled as a 200px crest - which is the half
  // of a card that decides whether anybody clicks. The bytes are served by the same service, on
  // their own URL, because an unfurler fetches `og:image` as a second request.
  const hasOwnImage = !!post.image;
  const image = hasOwnImage
    ? `${siteOrigin()}/api/public/posts/${encodeURIComponent(postId)}/preview-image`
    : publicMediaUrl(post.association?.logoUrl);
  const imageAlt = hasOwnImage
    ? author
      ? m.seo_post_image_alt({ association: author })
      : undefined
    : author
      ? m.seo_logo_alt({ name: author })
      : undefined;
  const url = pageUrl(path);

  return {
    title,
    description,
    ogType: 'article',
    image,
    imageAlt,
    // Declared only for the post's own photo: those numbers are stored beside it. A logo's are
    // nobody's here - see `renderSeoTags`.
    imageWidth: post.image?.width ?? undefined,
    imageHeight: post.image?.height ?? undefined,
    publishedAt: post.createdAt,
    authorName: author ?? undefined,
    jsonLd: [
      buildArticleJsonLd({
        url,
        headline: title,
        description,
        image,
        authorName: author,
        authorIsOrganization: !!author,
        publishedAt: post.createdAt,
        modifiedAt: post.updatedAt,
      }),
      buildBreadcrumbJsonLd([
        { name: SITE.name, path: '/' },
        { name: 'Publications', path: '/posts' },
        { name: title, path },
      ]),
    ],
  };
}

interface FormPayload {
  title?: string;
  description?: string;
  imageUrl?: string | null;
}

async function formSeo(formId: string): Promise<Partial<SeoMeta> | null> {
  const form = await fetchJson<FormPayload>(
    `${SOCIAL_URL()}/api/forms/${encodeURIComponent(formId)}`
  );
  if (!form?.title?.trim()) return null;

  return {
    title: form.title.trim(),
    description: form.description?.trim()
      ? truncateForMeta(markdownToPlainText(form.description), 200)
      : `Formulaire ${SITE.name} : inscription ou réponse en ligne.`,
    image: publicMediaUrl(form.imageUrl),
  };
}

interface AssociationPayload {
  name?: string;
  description?: string | null;
  bioMarkdown?: string | null;
  logoUrl?: string | null;
  contactEmail?: string | null;
  memberCount?: number;
}

async function associationSeo(slug: string, path: string): Promise<Partial<SeoMeta> | null> {
  // The safe projection, not `/api/associations/slug/:slug`: this one is designed to be public.
  const asso = await fetchJson<AssociationPayload>(
    `${SOCIAL_URL()}/api/public/associations/slug/${encodeURIComponent(slug)}`
  );
  if (!asso?.name) return null;

  const members =
    asso.memberCount != null
      ? `${asso.memberCount} membre${asso.memberCount > 1 ? 's' : ''}.`
      : null;

  // The bio is the association's own prose and the richest text this page will ever carry; the
  // short description is the fallback, and the generated sentence the last resort.
  const ownText = asso.description?.trim() || markdownToPlainText(asso.bioMarkdown ?? '');
  const description = ownText
    ? truncateForMeta(ownText, 200)
    : [
        `${asso.name} sur ${SITE.name} : actualités, agenda et formulaires de l'association.`,
        members,
      ]
        .filter(Boolean)
        .join(' ');
  const image = publicMediaUrl(asso.logoUrl);
  const url = pageUrl(path);

  return {
    // The association is what the page is about, but "BDE" alone is a query nobody wins - the
    // school has to be in the title for the result to be findable at all.
    title: `${asso.name} - ${SITE.institutionName}`,
    description,
    image,
    imageAlt: `Logo ${asso.name}`,
    jsonLd: [
      buildAssociationJsonLd({
        url,
        name: asso.name,
        description,
        logo: image,
        email: asso.contactEmail,
      }),
      buildBreadcrumbJsonLd([
        { name: SITE.name, path: '/' },
        { name: 'Associations', path: '/associations' },
        { name: asso.name, path },
      ]),
    ],
  };
}

interface ProfilePayload {
  displayName?: string | null;
  promo?: number | null;
  formation?: string | null;
}

async function profileSeo(userId: string): Promise<Partial<SeoMeta> | null> {
  const user = await fetchJson<ProfilePayload>(
    `${CORE_URL()}/api/internal/users/${encodeURIComponent(userId)}/public-profile`,
    internalHeaders()
  );
  if (!user?.displayName?.trim()) return null;

  const details = [user.promo ? `Promo ${user.promo}` : null, user.formation]
    .filter(Boolean)
    .join(' - ');

  return {
    title: user.displayName.trim(),
    description: details ? `${details}. Membre ${SITE.name}.` : `Membre ${SITE.name}.`,
  };
}

interface WorkspaceInvitePayload {
  valid?: boolean;
  workspaceName?: string | null;
  imageMediaId?: string | null;
}

async function communityInviteSeo(token: string): Promise<Partial<SeoMeta> | null> {
  const invite = await fetchJson<WorkspaceInvitePayload>(
    `${SOCIAL_URL()}/api/internal/channel-invites/${encodeURIComponent(token)}`,
    internalHeaders()
  );
  if (!invite?.valid || !invite.workspaceName?.trim()) return null;

  const name = invite.workspaceName.trim();
  return {
    title: m.seo_community_invite_title({ name }),
    description: m.seo_community_invite_description({ name }),
    image: invite.imageMediaId
      ? publicMediaUrl(`/api/media/public/${invite.imageMediaId}`)
      : undefined,
    imageAlt: invite.imageMediaId ? m.seo_invite_image_alt({ name }) : undefined,
    noindex: true,
  };
}

interface GroupInvitePayload {
  valid?: boolean;
  groupName?: string | null;
  /** The group avatar - a RAW public blob, which is what makes it fetchable with no session. */
  imageMediaId?: string | null;
}

/**
 * The group half of the invite pair, and it had no picture at all until 2026-09-20: a community
 * invite carried its image while the group beside it showed the site logo, for no reason other
 * than `resolveGroupInvitePreview` not selecting the column. Groups have avatars, stored the same
 * public way community images are.
 */
async function groupInviteSeo(token: string): Promise<Partial<SeoMeta> | null> {
  const invite = await fetchJson<GroupInvitePayload>(
    `${DELIVERY_URL()}/api/internal/group-invites/${encodeURIComponent(token)}`,
    internalHeaders()
  );
  if (!invite?.valid || !invite.groupName?.trim()) return null;

  const name = invite.groupName.trim();
  return {
    title: m.seo_group_invite_title({ name }),
    description: m.seo_group_invite_description({ name }),
    image: invite.imageMediaId
      ? publicMediaUrl(`/api/media/public/${invite.imageMediaId}`)
      : undefined,
    imageAlt: invite.imageMediaId ? m.seo_invite_image_alt({ name }) : undefined,
    noindex: true,
  };
}

/**
 * The one enrichment table. Each entry owns a path shape and the single call that resolves it;
 * anything not listed falls through to `resolveSeoForPath` alone, which is a complete answer for
 * the static pages and a correct generic one for everything else.
 */
const ENRICHERS: [RegExp, (id: string, path: string) => Promise<Partial<SeoMeta> | null>][] = [
  [/^\/posts\/([^/]+)\/?$/, postSeo],
  [/^\/forms\/([^/]+)\/?$/, formSeo],
  [/^\/associations\/([^/]+)\/?$/, associationSeo],
  [/^\/profile\/([^/]+)\/?$/, profileSeo],
  [/^\/c\/join\/([^/]+)\/?$/, communityInviteSeo],
  [/^\/g\/join\/([^/]+)\/?$/, groupInviteSeo],
];

interface CalendarEventPayload {
  id?: string;
  title?: string;
  description?: string | null;
  startsAt?: string;
  endsAt?: string | null;
  imageUrl?: string | null;
  associationName?: string | null;
  associationSlug?: string | null;
}

/** How many upcoming events the agenda page describes. Beyond this the payload stops being read. */
const AGENDA_JSONLD_MAX = 25;
/** How far ahead the agenda looks. The feed refuses a range wider than ~18 months. */
const AGENDA_WINDOW_DAYS = 180;

/**
 * `Event` nodes for the agenda page.
 *
 * The one page whose content is genuinely searchable - "gala Mines Saint-Etienne", "soirée BDE" -
 * and the one schema.org type Google renders as a rich result with its dates attached. It reads
 * the same public feed the ICS export uses, so nothing pending or rejected can appear.
 */
async function agendaJsonLd(): Promise<JsonLdNode[] | null> {
  const from = new Date();
  const to = new Date(from.getTime() + AGENDA_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await fetchJson<CalendarEventPayload[]>(
    `${SOCIAL_URL()}/api/associations/calendar/feed?from=${from.toISOString()}&to=${to.toISOString()}`
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const events = rows
    .filter((row) => row.title?.trim() && row.startsAt)
    .slice(0, AGENDA_JSONLD_MAX)
    .map((row) =>
      buildEventJsonLd({
        name: row.title!.trim(),
        description: row.description?.trim()
          ? truncateForMeta(markdownToPlainText(row.description), 300)
          : null,
        startDate: new Date(row.startsAt!).toISOString(),
        endDate: row.endsAt ? new Date(row.endsAt).toISOString() : null,
        // No per-event page exists, so every event points at the agenda that lists it.
        url: pageUrl('/calendar'),
        image: publicMediaUrl(row.imageUrl),
        organizerName: row.associationName,
        organizerUrl: row.associationSlug ? pageUrl(`/associations/${row.associationSlug}`) : null,
      })
    );

  return events.length > 0 ? [buildEventListJsonLd(events)] : null;
}

/** Structured data for the pages that have no id in their path. */
async function staticPageJsonLd(path: string): Promise<JsonLdNode[] | null> {
  if (path === '/' || path === '/posts') return buildSiteJsonLd();
  if (path === '/calendar') return agendaJsonLd();
  if (path === '/associations') {
    return [
      ...buildSiteJsonLd(),
      buildBreadcrumbJsonLd([
        { name: SITE.name, path: '/' },
        { name: 'Associations', path: '/associations' },
      ]),
    ];
  }
  return null;
}

/** Resolves the metadata for a pathname, enriching it from the services when one applies. */
export async function resolveServerSeo(pathname: string): Promise<SeoMeta> {
  const cached = cacheGet(pathname);
  if (cached) return cached;

  const base = resolveSeoForPath(pathname);

  // A literal segment beats a parameterised one, here as in SvelteKit's own router: a page that
  // exists is never an id. Asking anyway is how `/forms/success` spent every payment asking
  // social-service for a form called `success`.
  if (!isStaticPageRoute(pathname)) {
    for (const [pattern, enrich] of ENRICHERS) {
      const match = pathname.match(pattern);
      if (!match) continue;
      const enriched = await enrich(decodeURIComponent(match[1]), pathname);
      return cachePut(pathname, enriched ? mergeSeo(base, enriched) : base);
    }
  }

  // Structured data is pointless on a page that asks not to be indexed.
  const jsonLd = base.noindex ? null : await staticPageJsonLd(normalizePath(pathname));
  return cachePut(pathname, jsonLd ? { ...base, jsonLd } : base);
}
