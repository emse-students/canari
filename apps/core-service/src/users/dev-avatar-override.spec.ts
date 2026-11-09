/// <reference types="jest" />

import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AvatarService } from './avatar.service';
import { DEV_ESTATE_HOST, isDevEstate, loadDevAvatars } from './dev-avatar-override';

jest.mock('axios');

const files: Record<string, Buffer> = {
  '/d/index.json': Buffer.from(JSON.stringify({ 'user-a': 'a.png' })),
  '/d/a.png': Buffer.from([137, 80, 78, 71, 1, 2, 3]),
  '/d/b.png': Buffer.from([137, 80, 78, 71, 9, 9, 9]),
};
const read = (p: string): Buffer => {
  const f = files[p.split(String.fromCharCode(92)).join('/')];
  if (!f) throw new Error(`no file ${p}`);
  return f;
};
const DEV = `https://${DEV_ESTATE_HOST}`;

describe('the dev avatar override', () => {
  it('serves the listed accounts on the dev estate', () => {
    const m = loadDevAvatars('/d', 'user-b=b.png', DEV, read);
    expect([...m.keys()].sort()).toEqual(['user-a', 'user-b']);
    expect(m.get('user-a')?.contentType).toBe('image/png');
    expect(m.get('user-a')?.etag).toMatch(/^"dev-[0-9a-f]{64}"$/);
    expect(m.get('user-a')?.etag).not.toBe(m.get('user-b')?.etag);
  });

  it('refuses an EXTRA pair that is not exactly id=file, and keeps __proto__ as an ordinary id', () => {
    expect(() => loadDevAvatars('/d', 'user-b=b.png=junk', DEV, read)).toThrow(/malformed EXTRA/);
    expect(() => loadDevAvatars('/d', 'user-b', DEV, read)).toThrow(/malformed EXTRA/);
    expect(loadDevAvatars('/d', '__proto__=b.png', DEV, read).has('__proto__')).toBe(true);
  });

  it('is off when no directory is named, on any estate', () => {
    expect(loadDevAvatars(undefined, undefined, 'https://canari.emse.fr', read).size).toBe(0);
    expect(loadDevAvatars('', undefined, DEV, read).size).toBe(0);
  });

  it.each([
    'https://canari.emse.fr',
    'https://canari-emse.fr,https://dev.canari-emse.fr',
    'https://dev.canari-emse.fr.evil.example',
    'https://evil.example/dev.canari-emse.fr',
    '',
    undefined,
  ])('REFUSES TO BOOT outside the dev estate (FRONTEND_URL=%s)', (url) => {
    expect(isDevEstate(url as string | undefined)).toBe(false);
    expect(() => loadDevAvatars('/d', undefined, url as string | undefined, read)).toThrow(
      /refusing to boot/
    );
  });

  it('refuses a malformed entry rather than reading a path it was not meant to', () => {
    expect(() => loadDevAvatars('/d', 'user-b=../../etc/passwd', DEV, read)).toThrow(
      /refused entry/
    );
    expect(() => loadDevAvatars('/d', 'bad id=b.png', DEV, read)).toThrow(/refused entry/);
  });

  it('the service cannot be built on production with the variable set, and serves nothing there without it', async () => {
    const cfg = (env: Record<string, string>) =>
      ({ get: (k: string, d?: string) => env[k] ?? d }) as unknown as ConfigService;
    expect(
      () =>
        new AvatarService(
          cfg({ DEV_AVATAR_OVERRIDE_DIR: '/d', FRONTEND_URL: 'https://canari.emse.fr' })
        )
    ).toThrow(/refusing to boot/);
    const prod = new AvatarService(cfg({ FRONTEND_URL: 'https://canari.emse.fr' }));
    expect(await prod.fetchUserAvatar('user-a')).toEqual({ kind: 'disabled' });
    expect(await prod.fetchAvatarPresence(['user-a'])).toEqual(new Set());
  });

  describe('on the dev estate', () => {
    const dev = (env: Record<string, string> = {}) =>
      new AvatarService({
        get: (k: string, d?: string) =>
          ({
            DEV_AVATAR_OVERRIDE_DIR: '/d',
            FRONTEND_URL: DEV,
            DEV_AVATAR_OVERRIDE_EXTRA: '',
            ...env,
          })[k] ?? d,
      } as unknown as ConfigService);

    beforeEach(() => jest.restoreAllMocks());

    it('serves a listed id its image even with MIGALLERY_API_KEY empty, without asking the gallery', async () => {
      jest
        .spyOn(require('node:fs'), 'readFileSync')
        .mockImplementation(((p: string) => read(p)) as never);
      const get = jest.spyOn(axios, 'get');
      const out = await dev({ MIGALLERY_API_KEY: '' }).fetchUserAvatar('user-a');
      expect(out).toMatchObject({ kind: 'image', contentType: 'image/png' });
      expect(get).not.toHaveBeenCalled();
    });

    it('merges its own ids into the upstream presence set, and passes null through', async () => {
      jest
        .spyOn(require('node:fs'), 'readFileSync')
        .mockImplementation(((p: string) => read(p)) as never);
      const svc = dev({ MIGALLERY_API_KEY: 'k' });
      const get = jest.spyOn(axios, 'get').mockResolvedValue({ data: { withPhoto: ['other'] } });
      expect(await svc.fetchAvatarPresence(['user-a', 'other', 'nobody'])).toEqual(
        new Set(['other', 'user-a'])
      );
      get.mockResolvedValue({ data: {} });
      expect(await svc.fetchAvatarPresence(['user-a'])).toBeNull();
    });
  });
});
