export interface AppPlace {
  id: string;
  label: string;
  description: string;
  icon: 'message-circle' | 'newspaper' | 'users' | 'phone' | 'calendar-days';
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
    description: 'Le fil social de la communaute',
    icon: 'newspaper',
    href: '/posts',
    enabled: true,
  },
  {
    id: 'communities',
    label: 'Communautes',
    description: "Espaces d'association et canaux",
    icon: 'users',
    href: '/communities',
    enabled: true,
  },
  {
    id: 'calls',
    label: 'Appels',
    description: 'Audio et video en temps reel',
    icon: 'phone',
    href: '/calls',
    enabled: false,
    badge: 'Bientot',
  },
  {
    id: 'events',
    label: 'Evenements',
    description: 'Calendrier, rendez-vous, annonces',
    icon: 'calendar-days',
    href: '/events',
    enabled: false,
    badge: 'Bientot',
  },
];

export function resolveActivePlaceId(pathname: string): string {
  const exact = APP_PLACES.find(
    (place) => pathname === place.href || pathname.startsWith(`${place.href}/`)
  );
  if (exact) return exact.id;
  return 'chat';
}
