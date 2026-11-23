import { PG_SESSION_OPTIONS } from './pg-session-options';

describe('PG_SESSION_OPTIONS', () => {
  it('pins the session zone to UTC, which the zone-less timestamp defaults are written in', () => {
    expect(PG_SESSION_OPTIONS).toContain('-c timezone=UTC');
  });
});
