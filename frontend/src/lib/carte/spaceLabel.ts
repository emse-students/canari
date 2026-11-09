import { m } from '$lib/paraglide/messages';
import { campusLabel } from '$lib/profile/miconnectProfile';
import type { CarteSpace } from '$lib/associations/api';

/**
 * A map's space in words: "ICM - Saint-Étienne". The formation is a proper name the spaces table
 * stores as displayed; the campus goes through the profile's campus label, the one translation of it.
 */
export function carteSpaceLabel(space: Pick<CarteSpace, 'formation' | 'campus'>): string {
  const campus =
    space.campus === 'gardanne' || space.campus === 'saint-etienne'
      ? campusLabel(space.campus)
      : space.campus;
  return m.carte_space_option({ formation: space.formation, campus });
}
