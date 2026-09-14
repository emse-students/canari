import { m } from '$lib/paraglide/messages';
import { APP_PLACES } from '$lib/navigation/places';
import { SITE } from '$lib/seo/site';
import type { SeoMeta } from '$lib/seo/types';

/**
 * Every page this app does not offer to a search engine, by path prefix.
 *
 * ONE LIST, and `routes/robots.txt/+server.ts` writes its `Disallow:` lines from it. There were
 * two, and they disagreed: robots said `/profile/` and `/admin/` with a trailing slash, which
 * leaves `/profile` and `/admin` themselves crawlable, while this one said `/profile` and `/admin`
 * and left `/app-shell` out. Neither list had heard of `/directory`, `/events`, `/lists`,
 * `/settings` or `/documents` - and `/directory` is the student directory.
 *
 * A path belongs here when a crawler has nothing to gain from it, which on a SPA is every page
 * whose content arrives only after a session does. What IS offered is the sitemap
 * (`PUBLIC_SITEMAP_ENTRIES`), and nothing may be in both.
 */
export const PRIVATE_PREFIXES = [
  '/account',
  '/admin',
  // The shell nginx serves when the SSR container is unreachable: the app booting on whatever URL
  // was asked for, so it has no content and no canonical URL of its own.
  '/app-shell',
  '/auth',
  '/chat',
  '/communities',
  '/dashboard',
  '/dev',
  '/directory',
  '/documents',
  '/events',
  '/lists',
  '/login',
  '/notifications',
  '/profile',
  '/settings',
  // Invite links carry a one-time token and now unfurl with the real community or group name.
  // Previewing for whoever holds the link is the point; being listed in a search index is not.
  '/c/join',
  '/g/join',
] as const;

/**
 * The three pages written FOR a search result, and the only ones whose description is read by
 * anybody. The title is the same message the page renders as its heading: it was a second literal
 * here until 2026-09-14, and the two had already drifted - this file said "Conditions générales
 * d'utilisation" while the page said "Conditions Générales d'Utilisation", so the tab and the
 * `og:title` of one document disagreed on the casing of its own name.
 *
 * Lazy because a Paraglide message must be called at render time, never at module init - the same
 * reason `AppPlace.label` is a function.
 */
const LEGAL_SEO: Record<string, () => SeoMeta> = {
  '/legal/cgu': () => ({
    title: m.legal_cgu_title(),
    description:
      "Conditions générales d'utilisation de Canari, plateforme de communication sécurisée pour l'EMSE.",
    path: '/legal/cgu',
  }),
  '/legal/privacy': () => ({
    title: m.legal_privacy_title(),
    description: 'Comment Canari traite vos données personnelles, cookies et droits RGPD.',
    path: '/legal/privacy',
  }),
  '/legal/child-safety': () => ({
    title: m.legal_child_safety_title(),
    description:
      'Engagements de Canari pour la protection des mineurs et le signalement de contenus.',
    path: '/legal/child-safety',
  }),
};

/**
 * A page of the admin console is named for its section, prefixed so a tab can tell it from the
 * public page of the same name - `/admin/associations` and `/associations` both read "Associations"
 * otherwise.
 */
function adminTitle(section: string): string {
  return m.seo_admin_page_title({ page: section });
}

/**
 * THE NAME OF EVERY PAGE THE APP NAV DOES NOT ALREADY NAME, AND THE ONLY PLACE ANY OF THEM IS NAMED.
 *
 * `placeSeo` below covers the eight places in the sidebar, and the branches in `resolveSeoForPath`
 * cover the public pages. EVERYTHING ELSE FELL THROUGH TO `SITE.defaultTitle`: measured on dev
 * 2026-09-14, twenty of the forty static routes opened a tab reading "Canari - Mines Saint-Étienne",
 * including all thirteen admin pages, `/settings`, `/profile` and `/events`.
 *
 * Ten pages had worked around it with a `<svelte:head><title>` of their own, which is the second
 * half of the same defect: that title wins over the one `SeoHead` renders, but `og:title` and
 * `twitter:title` keep the layout's - so the document's name and its preview's name were two
 * different strings. Those ten no longer write one, `seoTitles.test.ts` fails if an eleventh
 * appears, and this table is the single owner.
 *
 * Every value is a reference to the message the page already displays, so a page's name exists
 * exactly once across the whole app. Lazy for the reason `LEGAL_SEO` is.
 */
const PAGE_TITLES: Record<string, () => string> = {
  '/account/purchases': () => m.purchases_heading(),
  '/admin': () => m.admin_title(),
  '/admin/agenda': () => adminTitle(m.admin_pending_agenda_label()),
  '/admin/associations': () => adminTitle(m.admin_associations_label()),
  '/admin/carte': () => adminTitle(m.carte_card_label()),
  '/admin/cercle': () => adminTitle(m.admin_cercle_label()),
  '/admin/document-reviewers': () => adminTitle(m.docreview_nav_label()),
  '/admin/legacy-cotisations': () => adminTitle(m.admin_legacy_title()),
  '/admin/moderation': () => adminTitle(m.moderation_title()),
  '/admin/platform': () => adminTitle(m.admin_platform_label()),
  '/admin/status': () => adminTitle(m.admin_status_title()),
  '/admin/storage': () => adminTitle(m.admin_storage_label()),
  '/admin/users': () => adminTitle(m.admin_admins_label()),
  '/associations/new': () => m.assoc_new_heading(),
  '/auth/callback': () => m.seo_auth_callback_title(),
  '/login': () => m.seo_login_title(),
  '/directory': () => m.directory_heading(),
  '/documents': () => m.reviewer_docs_title(),
  '/events': () => m.events_heading(),
  '/forms/cancel': () => m.form_cancel_title(),
  '/forms/create': () => m.form_create_heading(),
  '/forms/success': () => m.form_success_title(),
  '/lists': () => m.list_heading(),
  '/lists/new': () => m.list_new_create_btn(),
  '/profile': () => m.seo_profile_title(),
  '/settings': () => m.settings_page_title(),
};

function normalizePath(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return pathname.endsWith('/') && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
}

function isPrivatePath(pathname: string): boolean {
  const path = normalizePath(pathname);
  return PRIVATE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

function placeSeo(pathname: string): SeoMeta | null {
  const path = normalizePath(pathname);
  const place = APP_PLACES.find((p) => path === p.href || path.startsWith(`${p.href}/`));
  if (!place) return null;
  return {
    title: place.label(),
    description: `${place.description()} - ${SITE.name}, ${SITE.tagline}.`,
    path: place.href,
  };
}

/**
 * The SEO of a page that belongs to the APP rather than to the public site.
 *
 * `noindex` unconditionally, and that is finer-grained than `PRIVATE_PREFIXES` on purpose: robots
 * can only speak in prefixes, so `/forms/success` - the page one sees after paying - sits under a
 * crawlable one and is still nobody's search result.
 *
 * `SITE.defaultDescription` and NOT a sentence per page: a description is read by a crawler and an
 * unfurler, both of which are told `noindex` here, so a bespoke one would be twenty sentences
 * nobody reads. The title is different - a person reads that one, in their own tab.
 */
function appPageSeo(path: string, title: string): SeoMeta {
  return { title, description: SITE.defaultDescription, path, noindex: true };
}

/**
 * Default SEO for a pathname when the page does not supply `data.seo`.
 */
export function resolveSeoForPath(pathname: string): SeoMeta {
  const path = normalizePath(pathname);

  const legal = LEGAL_SEO[path];
  if (legal) {
    return { ...legal(), noindex: false };
  }

  if (path.startsWith('/c/join/')) {
    return appPageSeo(path, m.community_join_page_title());
  }

  if (path.startsWith('/g/join/')) {
    return appPageSeo(path, m.group_join_page_title());
  }

  const pageTitle = PAGE_TITLES[path];
  if (pageTitle) {
    return appPageSeo(path, pageTitle());
  }

  if (path === '/associations' || path.startsWith('/associations/')) {
    // `/associations/new` never reaches here: `PAGE_TITLES` above is consulted first and owns it.
    // It used to be excluded by a `!== 'new'` on this line, which was a second statement that the
    // creation page is not a slug.
    const slugMatch = path.match(/^\/associations\/([^/]+)$/);
    if (slugMatch) {
      const slug = decodeURIComponent(slugMatch[1]);
      return {
        title: slug,
        description: `Page publique de l'association ${slug} sur Canari : actualités, agenda et formulaires.`,
        path,
      };
    }
    return {
      title: 'Associations',
      description: 'Découvrez les associations EMSE sur Canari : fil, événements et inscriptions.',
      path: '/associations',
    };
  }

  if (path.startsWith('/posts/')) {
    return {
      title: 'Publication',
      description: 'Publication sur le fil social Canari.',
      path,
      ogType: 'article',
    };
  }

  if (path.startsWith('/forms/')) {
    return {
      title: 'Formulaire',
      description: 'Formulaire Canari : inscription ou réponse en ligne.',
      path,
    };
  }

  const fromPlace = placeSeo(path);
  if (fromPlace) {
    return { ...fromPlace, noindex: isPrivatePath(path) };
  }

  if (path === '/') {
    return {
      title: SITE.defaultTitle,
      description: SITE.defaultDescription,
      path: '/posts',
    };
  }

  return {
    title: SITE.defaultTitle,
    description: SITE.defaultDescription,
    path,
    noindex: isPrivatePath(path),
  };
}

/** Merges route-level SEO over pathname defaults. */
export function mergeSeo(base: SeoMeta, override?: Partial<SeoMeta> | null): SeoMeta {
  if (!override) return base;
  return {
    ...base,
    ...override,
    title: override.title?.trim() || base.title,
    description: override.description?.trim() || base.description,
  };
}

/** Ensures titles end with the site name when appropriate. */
export function formatDocumentTitle(title: string): string {
  const t = title.trim();
  if (!t) return SITE.name;
  if (t.toLowerCase().includes(SITE.name.toLowerCase())) return t;
  return `${t} - ${SITE.name}`;
}
