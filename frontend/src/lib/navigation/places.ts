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
    | 'shopping-bag';
  href: string;
}

// Ordre : Communautés | Feed | Discussions | Notifs | Tableau de bord
// (correspond à l'ordre de la bottom nav mobile et de la sidebar desktop)
export const APP_PLACES: AppPlace[] = [
  {
    id: 'communities',
    label: 'Communautés',
    description: "Espaces d'associations et canaux",
    icon: 'users',
    href: '/communities',
  },
  {
    id: 'posts',
    label: 'Feed',
    description: 'Le fil social de la communauté',
    icon: 'newspaper',
    href: '/posts',
  },
  {
    id: 'chat',
    label: 'Discussions',
    description: 'Messages directs et petits groupes',
    icon: 'message-circle',
    href: '/chat',
  },
  {
    id: 'notifications',
    label: 'Notifs',
    description: 'Réactions, mentions et commentaires',
    icon: 'bell',
    href: '/notifications',
  },
  {
    id: 'calendar',
    label: 'Agenda',
    description: 'Événements et calendrier',
    icon: 'calendar',
    href: '/calendar',
  },
  {
    id: 'shop',
    label: 'Boutique',
    description: 'Produits et cotisations',
    icon: 'shopping-bag',
    href: '/shop',
  },
  {
    id: 'dashboard',
    label: 'Tableau de bord',
    description: "Vue d'ensemble de l'application",
    icon: 'layout-dashboard',
    href: '/dashboard',
  },
];

export function resolveActivePlaceId(pathname: string): string {
  const exact = APP_PLACES.find(
    (place) => pathname === place.href || pathname.startsWith(`${place.href}/`)
  );
  if (exact) return exact.id;
  return 'chat';
}
