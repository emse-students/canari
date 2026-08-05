import { env } from '$env/dynamic/private';
import { mergeSeo, resolveSeoForPath } from '$lib/seo/resolve';
import { SITE, siteOrigin } from '$lib/seo/site';
import { markdownToPlainText, truncateForMeta } from '$lib/seo/text';
import type { SeoMeta } from '$lib/seo/types';

/**
 * Per-path Open Graph metadata, resolved on the server.
 *
 * The app is a SPA (`ssr = false`), so no component runs here - only this module does. It exists
 * because an unfurler or a crawler never executes the client, and therefore never sees a single
 * tag `SeoHead.svelte` emits: without it, every shared Canari link previews as the bare shell
 * title. It reads the SAME `resolveSeoForPath` the client uses as its baseline and only enriches
 * it with what needs a round trip.
 *
 * Every fetch here is best-effort. A slow or broken service degrades the preview to the generic
 * per-kind text; it must never fail the page, which is the app itself.
 */

/** Docker-network base URLs. Requests go direct, never back through nginx. */
const SOCIAL_URL = () =>
  (env.SOCIAL_SERVICE_URL || 'http://social-service:3014').replace(/\/$/, '');
const CORE_URL = () => (env.CORE_SERVICE_URL || 'http://core-service:3012').replace(/\/$/, '');
const DELIVERY_URL = () =>
  (env.DELIVERY_SERVICE_URL || 'http://chat-delivery-service:3010').replace(/\/$/, '');

/** Budget for one enrichment call. An unfurler gives up long before a user would. */
const FETCH_TIMEOUT_MS = 1500;

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

/** Headers proving a server-to-server call. Never the per-user `X-Internal-Token`. */
function internalHeaders(): Record<string, string> {
  const secret = env.INTERNAL_SECRET?.trim();
  if (!secret) {
    console.log('[SEO] INTERNAL_SECRET is unset - invite and profile previews will stay generic');
    return {};
  }
  return { 'X-Internal-Secret': secret };
}

/** GETs JSON with a hard timeout. Returns null on any failure, logging the cause. */
async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: abort.signal });
    if (!res.ok) {
      console.log(`[SEO] ${url} answered ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    // `fetch` reports every transport failure as a bare TypeError; the diagnosis is in `cause`.
    console.log(`[SEO] ${url} failed:`, (err as Error)?.message, (err as Error)?.cause ?? '');
    return null;
  } finally {
    clearTimeout(timer);
  }
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

interface PostPayload {
  markdown?: string;
  association?: { name?: string; logoUrl?: string | null } | null;
  authorDisplayName?: string | null;
  authorFirstName?: string | null;
  authorLastName?: string | null;
}

async function postSeo(postId: string): Promise<Partial<SeoMeta> | null> {
  const post = await fetchJson<PostPayload>(
    `${SOCIAL_URL()}/api/posts/${encodeURIComponent(postId)}`
  );
  if (!post) return null;

  const plain = markdownToPlainText(post.markdown ?? '');
  const author =
    post.association?.name ||
    [post.authorFirstName, post.authorLastName].filter(Boolean).join(' ') ||
    post.authorDisplayName ||
    null;

  // The title is the post's opening words and the description its body, so an author line in
  // front of the description is the only place the card can say WHO posted without repeating it.
  const description = plain
    ? truncateForMeta(author ? `${author} : ${plain}` : plain, 200)
    : `Publication sur le fil social ${SITE.name}.`;

  return {
    title: plain ? truncateForMeta(plain, 70) : 'Publication',
    description,
    ogType: 'article',
    image: publicMediaUrl(post.association?.logoUrl),
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
  logoUrl?: string | null;
  memberCount?: number;
}

async function associationSeo(slug: string): Promise<Partial<SeoMeta> | null> {
  // The safe projection, not `/api/associations/slug/:slug`: this one is designed to be public.
  const asso = await fetchJson<AssociationPayload>(
    `${SOCIAL_URL()}/api/public/associations/slug/${encodeURIComponent(slug)}`
  );
  if (!asso?.name) return null;

  const members =
    asso.memberCount != null
      ? `${asso.memberCount} membre${asso.memberCount > 1 ? 's' : ''}.`
      : null;

  return {
    title: asso.name,
    description: asso.description?.trim()
      ? truncateForMeta(asso.description, 200)
      : [`${asso.name} sur ${SITE.name} : actualités, agenda et formulaires.`, members]
          .filter(Boolean)
          .join(' '),
    image: publicMediaUrl(asso.logoUrl),
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

  return {
    title: `Rejoindre ${invite.workspaceName.trim()}`,
    description: `Invitation à rejoindre la communauté ${invite.workspaceName.trim()} sur ${SITE.name}.`,
    image: invite.imageMediaId
      ? publicMediaUrl(`/api/media/public/${invite.imageMediaId}`)
      : undefined,
    noindex: true,
  };
}

interface GroupInvitePayload {
  valid?: boolean;
  groupName?: string | null;
}

async function groupInviteSeo(token: string): Promise<Partial<SeoMeta> | null> {
  const invite = await fetchJson<GroupInvitePayload>(
    `${DELIVERY_URL()}/api/internal/group-invites/${encodeURIComponent(token)}`,
    internalHeaders()
  );
  if (!invite?.valid || !invite.groupName?.trim()) return null;

  return {
    title: `Rejoindre ${invite.groupName.trim()}`,
    description: `Invitation à rejoindre la discussion ${invite.groupName.trim()} sur ${SITE.name}.`,
    noindex: true,
  };
}

/**
 * The one enrichment table. Each entry owns a path shape and the single call that resolves it;
 * anything not listed falls through to `resolveSeoForPath` alone, which is a complete answer for
 * the static pages and a correct generic one for everything else.
 */
const ENRICHERS: [RegExp, (id: string) => Promise<Partial<SeoMeta> | null>][] = [
  [/^\/posts\/([^/]+)\/?$/, postSeo],
  [/^\/forms\/([^/]+)\/?$/, formSeo],
  [/^\/associations\/([^/]+)\/?$/, associationSeo],
  [/^\/profile\/([^/]+)\/?$/, profileSeo],
  [/^\/c\/join\/([^/]+)\/?$/, communityInviteSeo],
  [/^\/g\/join\/([^/]+)\/?$/, groupInviteSeo],
];

/** Resolves the metadata for a pathname, enriching it from the services when one applies. */
export async function resolveServerSeo(pathname: string): Promise<SeoMeta> {
  const cached = cacheGet(pathname);
  if (cached) return cached;

  const base = resolveSeoForPath(pathname);

  for (const [pattern, enrich] of ENRICHERS) {
    const match = pathname.match(pattern);
    if (!match) continue;
    // `/associations/new` is the creation form, not a slug - the enricher 404s and we fall back.
    const enriched = await enrich(decodeURIComponent(match[1]));
    return cachePut(pathname, enriched ? mergeSeo(base, enriched) : base);
  }

  return cachePut(pathname, base);
}
