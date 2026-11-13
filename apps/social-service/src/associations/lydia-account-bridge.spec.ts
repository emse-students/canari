import {
  HELD_BUSINESSES_SQL,
  managedVendorTokenSql,
  swapBridge,
  vendorTokensHeldBy,
  type LydiaBridgeRow,
} from './lydia-account-bridge';

/** The pure parts of the bridge; its transitions are proven on PostgreSQL (the integration spec). */
const BRIDGE: LydiaBridgeRow = {
  associationId: 'asso-1',
  historicalVendorToken: 'vendor-historical',
  enrolledVendorToken: 'vendor-enrolled',
  state: 'historical',
  standbyKeyCiphertext: 'sealed-enrolled',
  standbyDashboardUrl: null,
  standbyReady: false,
  standbyReadinessCause: null,
  standbyReadinessAt: null,
  switchedAt: null,
  switchCount: 0,
  switchBackCount: 0,
  reissueCount: 0,
};

describe('lydia-account-bridge', () => {
  it('the managers manage the enrolled Business while the historical account collects, never the historical one', () => {
    const sql = managedVendorTokenSql('a', 'b');
    expect(sql).toContain(`WHEN b.state = 'historical' THEN b."enrolledVendorToken"`);
    expect(sql).toContain(`ELSE a."lydiaAccountId"`);
    expect(sql).not.toContain('historicalVendorToken');
  });

  it('a row token resolves through every Business held, active or standby, with its role', () => {
    expect(HELD_BUSINESSES_SQL).toContain(`'active'::text AS role`);
    expect(HELD_BUSINESSES_SQL).toContain(`'pending' ELSE 'retired'`);
  });

  it('vendorTokensHeldBy answers the trimmed, non-empty tokens', async () => {
    const query = jest.fn(async () => [
      { vendorToken: ' vendor-a ' },
      { vendorToken: null },
      { vendorToken: '' },
    ]);
    await expect(vendorTokensHeldBy(query, 'asso-1')).resolves.toEqual(['vendor-a']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('h."associationId" = $1'), [
      'asso-1',
    ]);
  });

  it('swapBridge refuses a transition that is not due, and writes nothing when the active Business moved', async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => [] as unknown[]);
    await expect(
      swapBridge({ query } as never, { ...BRIDGE, state: 'switched' }, 'switched', {
        ready: true,
        cause: null,
        at: null,
      })
    ).rejects.toThrow(/no switched transition/);
    await expect(
      swapBridge({ query } as never, { ...BRIDGE, enrolledVendorToken: null }, 'switched', {
        ready: true,
        cause: null,
        at: null,
      })
    ).rejects.toThrow(/no switched transition/);
    // The association's active Business is not the historical one: nothing is written.
    await expect(
      swapBridge({ query } as never, BRIDGE, 'switched', { ready: true, cause: null, at: null })
    ).rejects.toThrow(/is not the historical one/);
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).toMatch(/^\s*SELECT/);
  });
});
