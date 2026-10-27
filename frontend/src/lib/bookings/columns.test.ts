import { describe, expect, it } from 'vitest';
import { bookingPlace, columnsHidden } from './columns';

describe('columnsHidden (D44)', () => {
  it('hides the level for the one column bearing the space name', () => {
    expect(columnsHidden('Salle de musique', [{ name: 'Salle de musique' }])).toBe(true);
  });

  it('shows a single column named otherwise (a space set up before WP-R1)', () => {
    expect(columnsHidden('Foyer', [{ name: 'Piano' }])).toBe(false);
  });

  it('shows it for none and for two or more, even when one bears the space name', () => {
    expect(columnsHidden('Alumni', [])).toBe(false);
    expect(columnsHidden('Alumni', [{ name: 'Alumni' }, { name: 'Camille' }])).toBe(false);
  });
});

describe('bookingPlace', () => {
  it('names the space alone when the column bears its name', () => {
    expect(bookingPlace('Salle de musique', 'Salle de musique')).toBe('Salle de musique');
  });

  it('names the space then the column otherwise', () => {
    expect(bookingPlace('Alumni', 'Camille')).toBe('Alumni - Camille');
  });
});
