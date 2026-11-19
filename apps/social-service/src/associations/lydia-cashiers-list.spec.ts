import { listLydiaCashiers } from './lydia-cashiers-list';

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
        departureUntried: true,
      },
    ]);
    const [row] = await listLydiaCashiers(query, 'asso', 'vendor');
    expect(String(query.mock.calls[0][0])).toContain(
      'NOT EXISTS (SELECT 1 FROM association_members'
    );
    expect(String(query.mock.calls[0][0])).toContain('"previousRevokeUnconfirmedAt" IS NULL');
    expect(row).toMatchObject({
      id: 'c1',
      departed: true,
      departureUntried: true,
      state: 'confirmed',
    });
  });
});
