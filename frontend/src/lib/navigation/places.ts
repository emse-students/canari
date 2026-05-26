export interface AppPlace {
  id: string;
  label: string;
  description: string;
  icon:
    | 'message-circle'
    | 'newspaper'
    | 'users'
    | 'layout-dashboard'
    | 'bell'
    | 'calendar'
    | 'shopping-bag'
    | 'clipboard-list';
  href: string;
  /** Whether this place appears in the mobile bottom navigation bar. */
  mobileNav: boolean;
}

// Ordre mobile : Feed | Communautés | Discussions | Notifs | Tableau de bord
// La sidebar desktop affiche toutes les places (mobileNav ignoré).
export const APP_PLACES: AppPlace[] = [
  {
    id: 'posts',
    label: 'Feed',
    description: 'Le fil social de la communauté',
    icon: 'newspaper',
    href: '/posts',
    mobileNav: true,
  },
  {
    id: 'communities',
    label: 'Communautés',
    description: "Espaces d'associations et canaux",
    icon: 'users',
    href: '/communities',
    mobileNav: true,
  },
  {
    id: 'chat',
    label: 'Discussions',
    description: 'Messages directs et petits groupes',
    icon: 'message-circle',
    href: '/chat',
    mobileNav: true,
  },
  {
    id: 'notifications',
    label: 'Notifs',
    description: 'Réactions, mentions et commentaires',
    icon: 'bell',
    href: '/notifications',
    mobileNav: true,
  },
  {
    id: 'calendar',
    label: 'Agenda',
    description: 'Événements et calendrier',
    icon: 'calendar',
    href: '/calendar',
    mobileNav: false,
  },
  {
    id: 'forms',
    label: 'Formulaires',
    description: 'Inscriptions et sondages',
    icon: 'clipboard-list',
    href: '/forms',
    mobileNav: false,
  },
  {
    id: 'shop',
    label: 'Boutique',
    description: 'Produits et cotisations',
    icon: 'shopping-bag',
    href: '/shop',
    mobileNav: false,
  },
  {
    id: 'dashboard',
    label: 'Tableau de bord',
    description: "Vue d'ensemble de l'application",
    icon: 'layout-dashboard',
    href: '/dashboard',
    mobileNav: true,
  },
];

export function resolveActivePlaceId(pathname: string): string {
  const exact = APP_PLACES.find(
    (place) => pathname === place.href || pathname.startsWith(`${place.href}/`)
  );
  if (exact) return exact.id;
  return 'chat';
}
