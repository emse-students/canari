import { APP_PLACES } from '$lib/navigation/places';
import { SITE } from '$lib/seo/site';
import type { SeoMeta } from '$lib/seo/types';

const PRIVATE_PREFIXES = [
  '/chat',
  '/communities',
  '/admin',
  '/dev',
  '/auth',
  '/dashboard',
  '/profile',
  '/notifications',
  '/account',
] as const;

const LEGAL_SEO: Record<string, SeoMeta> = {
  '/legal/cgu': {
    title: "Conditions générales d'utilisation",
    description:
      "Conditions générales d'utilisation de Canari, plateforme de communication sécurisée pour l'EMSE.",
    path: '/legal/cgu',
  },
  '/legal/privacy': {
    title: 'Politique de confidentialité',
    description: 'Comment Canari traite vos données personnelles, cookies et droits RGPD.',
    path: '/legal/privacy',
  },
  '/legal/child-safety': {
    title: 'Normes de sécurité des enfants',
    description:
      'Engagements de Canari pour la protection des mineurs et le signalement de contenus.',
    path: '/legal/child-safety',
  },
};

function normalizePath(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return pathname.endsWith('/') && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
}

function isPrivatePath(pathname: string): boolean {
  const path = normalizePath(pathname);
  if (path === '/login') return true;
  return PRIVATE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

function placeSeo(pathname: string): SeoMeta | null {
  const path = normalizePath(pathname);
  const place = APP_PLACES.find((p) => path === p.href || path.startsWith(`${p.href}/`));
  if (!place) return null;
  return {
    title: place.label,
    description: `${place.description} — ${SITE.name}, ${SITE.tagline}.`,
    path: place.href,
  };
}

/**
 * Default SEO for a pathname when the page does not supply `data.seo`.
 */
export function resolveSeoForPath(pathname: string): SeoMeta {
  const path = normalizePath(pathname);

  if (LEGAL_SEO[path]) {
    return { ...LEGAL_SEO[path], noindex: false };
  }

  if (path === '/login') {
    return {
      title: 'Connexion',
      description: 'Connectez-vous à Canari avec votre compte EMSE (Authentik).',
      path: '/login',
      noindex: true,
    };
  }

  if (path === '/associations' || path.startsWith('/associations/')) {
    const slugMatch = path.match(/^\/associations\/([^/]+)$/);
    if (slugMatch && slugMatch[1] !== 'new') {
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
      title: SITE.name,
      description: SITE.defaultDescription,
      path: '/posts',
    };
  }

  return {
    title: SITE.name,
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
