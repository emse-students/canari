/// <reference types="jest" />

/**
 * THE GATE IN FRONT OF ADMINER (user, 2026-10-02: *"add an adminer route to canari, in a safe way"*).
 *
 * What these cases are built to catch, in the order a regression would hurt:
 *  - the route opening WITHOUT being asked for (the flag unset), or with a weak or absent secret;
 *  - a cookie that was forged, edited, or issued by another deployment's secret still being accepted;
 *  - an expired cookie, or one whose owner has since LOST the admin role, still opening the door;
 *  - a malformed value throwing instead of being refused.
 */
import { Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { ADMINER_SESSION_SECONDS, AdminerAccessService } from './adminer-access.service';

const SECRET = 'a-shared-secret-of-at-least-32-characters-long';
const NOW = 1_800_000_000_000;

function build(
  over: { enabled?: string; secret?: string; user?: { admin: boolean } | null | 'throws' } = {}
) {
  process.env.ADMINER_ENABLED = over.enabled ?? 'true';
  process.env.INTERNAL_SHARED_SECRET = over.secret ?? SECRET;
  const findOne = jest.fn(async () => {
    if (over.user === 'throws') throw new Error('not found');
    return over.user === undefined ? { admin: true } : over.user;
  });
  const service = new AdminerAccessService({ findOne } as never);
  return { service, findOne };
}

describe('AdminerAccessService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env.ADMINER_ENABLED;
    delete process.env.INTERNAL_SHARED_SECRET;
    jest.restoreAllMocks();
  });

  describe('failing closed', () => {
    it.each([
      ['the flag is unset', { enabled: '' }],
      ['the flag is false', { enabled: 'false' }],
      ['the flag is not exactly "true"', { enabled: 'TRUE' }],
      ['the secret is absent', { secret: '' }],
      ['the secret is too short to be one', { secret: 'short' }],
    ])('is closed when %s', async (_, over) => {
      const { service } = build(over);
      expect(service.enabled).toBe(false);
      expect(() => service.mint('admin-1')).toThrow('not enabled');
      expect(await service.verify('anything.at-all')).toBeNull();
    });

    it('says so at startup when it was asked for and the secret is weak', () => {
      const error = jest.spyOn(Logger.prototype, 'error');
      build({ secret: 'short' });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('stays CLOSED'));
    });

    it('is silent when nobody asked for it', () => {
      const error = jest.spyOn(Logger.prototype, 'error');
      build({ enabled: '', secret: '' });
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe('a session', () => {
    it('opens the door for the admin it was issued to', async () => {
      const { service } = build();
      expect(await service.verify(service.mint('admin-1', NOW), NOW + 1000)).toBe('admin-1');
    });

    it('lasts fifteen minutes from the moment it was issued, and not a moment longer', async () => {
      const { service } = build();
      const cookie = service.mint('admin-1', NOW);
      const lastMoment = NOW + ADMINER_SESSION_SECONDS * 1000;
      expect(ADMINER_SESSION_SECONDS).toBe(900);
      expect(await service.verify(cookie, lastMoment - 1)).toBe('admin-1');
      expect(await service.verify(cookie, lastMoment)).toBeNull();
    });

    it('is refused once its owner is no longer a global admin, before it expires', async () => {
      const { service } = build({ user: { admin: false } });
      expect(await service.verify(service.mint('admin-1', NOW), NOW + 1000)).toBeNull();
    });

    it('is refused when its owner cannot be found', async () => {
      const { service } = build({ user: 'throws' });
      expect(await service.verify(service.mint('ghost', NOW), NOW + 1000)).toBeNull();
    });
  });

  describe('a cookie that is not the one issued', () => {
    const { service } = build();
    const good = service.mint('admin-1', NOW);
    const [payload, signature] = good.split('.');
    const reissue = (claims: object) => Buffer.from(JSON.stringify(claims)).toString('base64url');

    it.each([
      [
        'an edited subject',
        () => `${reissue({ sub: 'someone-else', exp: NOW + 1e6 })}.${signature}`,
      ],
      ['an extended expiry', () => `${reissue({ sub: 'admin-1', exp: NOW + 1e12 })}.${signature}`],
      ['a flipped signature', () => `${payload}.${signature.slice(0, -2)}AA`],
      ['a missing signature', () => `${payload}.`],
      ['no separator at all', () => payload],
      ['a third segment', () => `${payload}.${signature}.extra`],
      ['an empty value', () => ''],
      ['garbage', () => '!!!.???'],
    ])('is refused: %s', async (_, make) => {
      const { service: fresh } = build();
      expect(await fresh.verify(make(), NOW + 1000)).toBeNull();
    });

    it('is refused when it was signed with another secret', async () => {
      const other = build({ secret: 'another-shared-secret-of-at-least-32-chars!!' });
      const foreign = other.service.mint('admin-1', NOW);
      const { service: ours } = build();
      expect(await ours.verify(foreign, NOW + 1000)).toBeNull();
    });

    it('is refused when it was signed with the RAW shared secret instead of the derived key', async () => {
      const claims = reissue({ sub: 'admin-1', exp: NOW + 1e6 });
      const raw = createHmac('sha256', SECRET).update(claims).digest('base64url');
      const { service: ours } = build();
      expect(await ours.verify(`${claims}.${raw}`, NOW + 1000)).toBeNull();
    });

    it('is refused when it carries claims of the wrong shape, even correctly signed', async () => {
      const { service: ours } = build();
      const mintRaw = (claims: object) => {
        const body = reissue(claims);
        // Re-sign through the service's own method so ONLY the claims are wrong.
        const signed = (ours as unknown as { sign(p: string): string }).sign(body);
        return `${body}.${signed}`;
      };
      expect(await ours.verify(mintRaw({ sub: 7, exp: NOW + 1e6 }), NOW)).toBeNull();
      expect(await ours.verify(mintRaw({ sub: 'admin-1', exp: 'soon' }), NOW)).toBeNull();
      expect(await ours.verify(mintRaw({}), NOW)).toBeNull();
    });
  });
});
