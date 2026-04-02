export interface AppPlace {
  id: string;
  label: string;
  description: string;
  icon:
    | 'message-circle'
    | 'newspaper'
    | 'users'
    | 'phone'
    | 'calendar-days'
    | 'layout-dashboard'
    | 'file-text';
  href: string;
  enabled: boolean;
  badge?: string;
}

export const APP_PLACES: AppPlace[] = [
  {
    id: 'chat',
    label: 'Discussions',
    description: 'Messages directs et petits groupes',
    icon: 'message-circle',
    href: '/chat',
    enabled: true,
  },
  {
    id: 'posts',
    label: 'Posts',
    description: 'Le fil social de la communauté',
    icon: 'newspaper',
    href: '/posts',
    enabled: true,
  },
  {
    id: 'communities',
    label: 'Communautés',
    description: "Espaces d'associations et canaux",
    icon: 'users',
    href: '/communities',
    enabled: true,
  },
  {
    id: 'events',
    label: 'Évènements',
    description: 'Calendrier, rendez-vous, évènements',
    icon: 'calendar-days',
    href: '/events',
    enabled: true,
  },
  {
    id: 'forms',
    label: 'Formulaires',
    description: 'Sondages et inscriptions',
    icon: 'file-text',
    href: '/forms',
    enabled: true,
  },
  {
    id: 'associations',
    label: 'Associations',
    description: 'Les associations de la communauté',
    icon: 'users',
    href: '/associations',
    enabled: true,
  },
  {
    id: 'dashboard',
    label: 'Tableau de bord',
    description: "Gestion de l'association",
    icon: 'layout-dashboard',
    href: '/dashboard/association',
    enabled: true,
  },
  {
    id: 'calls',
    label: 'Appels',
    description: 'Audio et vidéo en temps réel',
    icon: 'phone',
    href: '/calls',
    enabled: false,
    badge: 'Bientôt',
  },
];

export function resolveActivePlaceId(pathname: string): string {
  const exact = APP_PLACES.find(
    (place) => pathname === place.href || pathname.startsWith(`${place.href}/`)
  );
  if (exact) return exact.id;
  return 'chat';
}
