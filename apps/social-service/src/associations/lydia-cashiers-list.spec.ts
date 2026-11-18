import { listLydiaCashiers, owesDepartureRemoval } from './lydia-cashiers-list';

describe('owesDepartureRemoval - the one predicate of a departure debt', () => {
  it('a departed Tresorier or Vendeur owes every number; a member owes nothing', () => {
    for (const role of ['tresorier', 'vendeur'] as const) {
      expect(owesDepartureRemoval({ departed: true, role, previousPhoneEnd: null })).toBe(true);
      expect(owesDepartureRemoval({ departed: false, role, previousPhoneEnd: null })).toBe(false);
    }
  });

  it('a departed Responsable owes only their OTHER number, never their current one', () => {
    expect(
      owesDepartureRemoval({ departed: true, role: 'responsable', previousPhoneEnd: null })
    ).toBe(false);
    expect(
      owesDepartureRemoval({ departed: true, role: 'responsable', previousPhoneEnd: '99' })
    ).toBe(true);
  });
});

describe('listLydiaCashiers - the card reads a departure from the membership table', () => {
  it('asks whether each row is still a member, and answers it as `departed`', async () => {
    const query = jest.fn(async (_sql: string, _params: unknown[]) => [
      {
        id: 'c1',
        userId: 'u1',
        role: 'vendeur',
        phoneEnd: '42',
        previousPhoneEnd: null,
        addedAt: '2026-11-18T10:00:00.000Z',
        confirmed: true,
        revokeUnconfirmed: false,
        departed: true,
      },
    ]);
    const [row] = await listLydiaCashiers(query, 'asso', 'vendor');
    expect(String(query.mock.calls[0][0])).toContain(
      'NOT EXISTS (SELECT 1 FROM association_members'
    );
    expect(row).toMatchObject({ id: 'c1', departed: true, state: 'confirmed' });
  });
});
