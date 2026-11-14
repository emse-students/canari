import { DELIVERY_URL, SOCIAL_URL, fetchJsonOrThrow, internalHeaders } from '$lib/seo/internalApi';
import {
  buildArticleJsonLd,
  buildAssociationJsonLd,
  buildBreadcrumbJsonLd,
  buildSiteJsonLd,
  type JsonLdNode,
} from '$lib/seo/jsonLd';
import { m } from '$lib/paraglide/messages';
import { wordingFor, type AssociationKind } from '$lib/associations/kindWording';
import {
  ASSOCIATION_EDIT_PATH,
  DOCUMENT_TITLE_SUFFIX,
  mergeSeo,
  resolveSeoForPath,
} from '$lib/seo/resolve';
import { isStaticPageRoute, normalizePath } from '$lib/seo/staticRoutes';
import { UpstreamUnavailableError } from '$lib/seo/upstream';
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

/**
 * The lengths a shared post's card is cut to, measured against what the unfurlers display.
 *
 * Facebook and Messenger truncate a title past ~60 characters and a description past ~125, so the
 * old 70 + " - Canari" (79) and 200 were cut a second time, by the unfurler, mid-word - which is
 * what opengraph.xyz reported on a real post (2026-10-18). Cutting here, between words, decides
 * where the card stops instead of leaving it to each consumer.
 */
const POST_CARD_TITLE_MAX = 60;
const POST_CARD_DESCRIPTION_MAX = 125;

/**
 * What `/api/public/posts/:id/preview-image` always returns. The numbers are social-service's
 * (`POST_CARD_WIDTH`, `POST_CARD_HEIGHT`, `POST_CARD_CONTENT_TYPE` in `post-card-image.ts`): this
 * is a different deployable, so they are stated here once more and must move together.
 */
export const POST_CARD_IMAGE = { width: 1200, height: 630, type: 'image/jpeg' } as const;

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
  const post = await fetchJsonOrThrow<PostPreviewPayload>(
    `${SOCIAL_URL()}/api/public/posts/${encodeURIComponent(postId)}/preview`
  );
  if (!post) return null;

  const plain = markdownToPlainText(post.markdown ?? '');
  const author = post.association?.name?.trim() || null;

  // The title is the post's opening words, and the association's name when it has none - a photo
  // post used to title itself "Publication", which is the word the whole feed shares. Its budget
  // is the WHOLE `og:title`, the site suffix included: the card shows that string, not this one.
  const title = plain
    ? truncateForMeta(plain, POST_CARD_TITLE_MAX - DOCUMENT_TITLE_SUFFIX.length)
    : author
      ? m.seo_post_title_from({ association: author })
      : SITE.name;
  // An author line in front of the description is the only place the card says WHO posted without
  // spending the title on it.
  const description = plain
    ? truncateForMeta(
        author ? m.seo_post_byline({ author, text: plain }) : plain,
        POST_CARD_DESCRIPTION_MAX
      )
    : author
      ? m.seo_post_description_fallback({ association: author })
      : `${SITE.name}.`;

  // ONE CARD PER POST, SERVED BY THE SAME SERVICE AND ALWAYS 1200x630 JPEG: the post's own photo
  // cropped to fit, else the association's logo on a plain brand background (post-card-image.ts in
  // social-service). The head used to offer the raw photo or the raw 512x512 logo, the logo with no
  // dimensions declared - the shape Messenger most often drops - so the numbers below are now a fact
  // of every post rather than of some. The URL is stable (no query), so an unfurler's cache and the
  // edge's both hold.
  const hasOwnImage = !!post.image;
  const image = `${siteOrigin()}/api/public/posts/${encodeURIComponent(postId)}/preview-image`;
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
    imageWidth: POST_CARD_IMAGE.width,
    imageHeight: POST_CARD_IMAGE.height,
    imageType: POST_CARD_IMAGE.type,
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
        { name: m.seo_posts_breadcrumb(), path: '/posts' },
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

/**
 * A shared form's card. The SSR request carries no identity, so it reads the PUBLIC route
 * (`/api/public/forms/:id`, an allowlist that answers public forms and 404 for the others): the
 * member route answered 401 every time and every shared link showed the generic card. A form that
 * is not public stays generic, which is the "public showcase only" rule (anonymous-surface.md).
 */
async function formSeo(formId: string): Promise<Partial<SeoMeta> | null> {
  const form = await fetchJsonOrThrow<FormPayload>(
    `${SOCIAL_URL()}/api/public/forms/${encodeURIComponent(formId)}`
  );
  if (!form?.title?.trim()) return null;

  return {
    title: form.title.trim(),
    description: form.description?.trim()
      ? truncateForMeta(markdownToPlainText(form.description), 200)
      : m.seo_form_fallback_description({ site: SITE.name }),
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
  const asso = await fetchJsonOrThrow<AssociationPayload>(
    `${SOCIAL_URL()}/api/public/associations/slug/${encodeURIComponent(slug)}`
  );
  if (!asso?.name) return null;

  const members =
    asso.memberCount != null
      ? asso.memberCount > 1
        ? m.seo_association_members_other({ count: asso.memberCount })
        : m.seo_association_members_one({ count: asso.memberCount })
      : null;

  // The bio is the association's own prose and the richest text this page will ever carry; the
  // short description is the fallback, and the generated sentence the last resort.
  const ownText = asso.description?.trim() || markdownToPlainText(asso.bioMarkdown ?? '');
  const description = ownText
    ? truncateForMeta(ownText, 200)
    : [m.seo_association_generated_description({ name: asso.name, site: SITE.name }), members]
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
    imageAlt: m.seo_logo_alt({ name: asso.name }),
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
        { name: m.assoc_list_heading(), path: '/associations' },
        { name: asso.name, path },
      ]),
    ],
  };
}

/**
 * The edit page's title, by the KIND of what it edits.
 *
 * The injected head wins over the page's own `pageTitle` hand-off (see `SeoHead`), so on a direct
 * load the generic title the path implies used to beat "Gestion de l'institution". The kind is
 * data only the service has, and the sentence comes from the same `wordingFor` row the page reads,
 * so the two can no longer disagree. An unknown slug keeps the path's own title.
 */
async function associationEditSeo(slug: string): Promise<Partial<SeoMeta> | null> {
  const asso = await fetchJsonOrThrow<{ type?: AssociationKind }>(
    `${SOCIAL_URL()}/api/public/associations/slug/${encodeURIComponent(slug)}`
  );
  if (!asso?.type || !(asso.type in KIND_TYPES)) return null;
  return { title: wordingFor(asso.type).editTitle() };
}

const KIND_TYPES: Record<AssociationKind, true> = {
  association: true,
  list: true,
  institution: true,
};

interface WorkspaceInvitePayload {
  valid?: boolean;
  workspaceName?: string | null;
  imageMediaId?: string | null;
}

async function communityInviteSeo(token: string): Promise<Partial<SeoMeta> | null> {
  const invite = await fetchJsonOrThrow<WorkspaceInvitePayload>(
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
  const invite = await fetchJsonOrThrow<GroupInvitePayload>(
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
 *
 * THE HEAD IS SERVED TO ANYBODY, SO IT SHOWS NO MORE THAN THE PUBLIC SHOWCASE (owner, 2026-11-02).
 * A person's profile (`/profile/<id>`: their name, promo and formation) and the agenda's events
 * (`/calendar`) were enriched here until that day and are not any more: portail-etu.emse.fr shows
 * neither. What is left is the association page (the showcase's own fields), the single shared
 * post the owner kept, and the invite links a member hands out. See docs/wiki/anonymous-surface.md.
 */
const ENRICHERS: [RegExp, (id: string, path: string) => Promise<Partial<SeoMeta> | null>][] = [
  [/^\/posts\/([^/]+)\/?$/, postSeo],
  [/^\/forms\/([^/]+)\/?$/, formSeo],
  [/^\/associations\/([^/]+)\/?$/, associationSeo],
  [ASSOCIATION_EDIT_PATH, associationEditSeo],
  [/^\/c\/join\/([^/]+)\/?$/, communityInviteSeo],
  [/^\/g\/join\/([^/]+)\/?$/, groupInviteSeo],
];

/**
 * Structured data for the pages that have no id in their path. Built from constants alone: the
 * agenda's events were read here until 2026-11-02, and no page without an id shows data now.
 */
function staticPageJsonLd(path: string): JsonLdNode[] | null {
  if (path === '/' || path === '/posts') return buildSiteJsonLd();
  if (path === '/associations') {
    return [
      ...buildSiteJsonLd(),
      buildBreadcrumbJsonLd([
        { name: SITE.name, path: '/' },
        { name: m.assoc_list_heading(), path: '/associations' },
      ]),
    ];
  }
  return null;
}

/** What {@link resolveServerSeo} answers: the head, and whether it is the degraded one. */
export interface ServerSeoResult {
  meta: SeoMeta;
  /**
   * True when an enrichment got NO ANSWER (the service was unreachable, out of budget or failing)
   * and `meta` is the generic head. Such a page must be served `no-store`: a refusal is an answer
   * and may be remembered, an absence of one is not, and a crawler or a shared cache that keeps it
   * pins the generic card to a post whose real one was a second away.
   */
  degraded: boolean;
}

/**
 * Resolves the metadata for a pathname, enriching it from the services when one applies.
 *
 * A REFUSAL (the service answered 4xx: no such post, not shareable) yields the generic head and is
 * cached like any answer. A TRANSPORT FAILURE of the enrichment (see {@link UpstreamUnavailableError})
 * yields the same generic head, flagged `degraded`, and is NEVER cached here: the 60 s cache is what
 * kept a one-off timeout of the 1.5 s budget alive for a minute of every unfurler's retries -
 * the intermittent Messenger preview failure of 2026-10-18.
 */
export async function resolveServerSeo(pathname: string): Promise<ServerSeoResult> {
  const cached = cacheGet(pathname);
  if (cached) return { meta: cached, degraded: false };

  const base = resolveSeoForPath(pathname);

  // A literal segment beats a parameterised one, here as in SvelteKit's own router: a page that
  // exists is never an id. Asking anyway is how `/forms/success` spent every payment asking
  // social-service for a form called `success`.
  if (!isStaticPageRoute(pathname)) {
    for (const [pattern, enrich] of ENRICHERS) {
      const match = pathname.match(pattern);
      if (!match) continue;
      try {
        const enriched = await enrich(decodeURIComponent(match[1]), pathname);
        return {
          meta: cachePut(pathname, enriched ? mergeSeo(base, enriched) : base),
          degraded: false,
        };
      } catch (err) {
        if (!(err instanceof UpstreamUnavailableError)) throw err;
        // Accuses, and names the path: the rate of these lines against the rate of requests is the
        // measure of how often a card is served without its content.
        console.warn(`[SEO] DEGRADED head for ${pathname}, enrichment unavailable: ${err.message}`);
        return { meta: base, degraded: true };
      }
    }
  }

  // Structured data is pointless on a page that asks not to be indexed.
  const jsonLd = base.noindex ? null : staticPageJsonLd(normalizePath(pathname));
  return { meta: cachePut(pathname, jsonLd ? { ...base, jsonLd } : base), degraded: false };
}
