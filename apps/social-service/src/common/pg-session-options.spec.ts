import { PG_SESSION_OPTIONS } from './pg-session-options';

describe('PG_SESSION_OPTIONS', () => {
  it('pins the session zone to UTC and keeps JIT off', () => {
    expect(PG_SESSION_OPTIONS).toContain('-c timezone=UTC');
    expect(PG_SESSION_OPTIONS).toContain('-c jit=off');
  });
});
