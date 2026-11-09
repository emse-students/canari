/// <reference types="jest" />

import { ConfigService } from '@nestjs/config';
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
    expect(m.get('user-a')?.etag).toMatch(/^"dev-/);
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
    expect(() => loadDevAvatars('/d', undefined, url as string | undefined, read)).toThrow(/refusing to boot/);
  });

  it('refuses a malformed entry rather than reading a path it was not meant to', () => {
    expect(() => loadDevAvatars('/d', 'user-b=../../etc/passwd', DEV, read)).toThrow(/refused entry/);
    expect(() => loadDevAvatars('/d', 'bad id=b.png', DEV, read)).toThrow(/refused entry/);
  });

  it('the service cannot be built on production with the variable set, and serves nothing there without it', async () => {
    const cfg = (env: Record<string, string>) => ({ get: (k: string, d?: string) => env[k] ?? d }) as unknown as ConfigService;
    expect(
      () => new AvatarService(cfg({ DEV_AVATAR_OVERRIDE_DIR: '/d', FRONTEND_URL: 'https://canari.emse.fr' }))
    ).toThrow(/refusing to boot/);
    const prod = new AvatarService(cfg({ FRONTEND_URL: 'https://canari.emse.fr' }));
    expect(await prod.fetchUserAvatar('user-a')).toEqual({ kind: 'disabled' });
    expect(await prod.fetchAvatarPresence(['user-a'])).toEqual(new Set());
  });
});
