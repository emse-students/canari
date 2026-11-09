import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The only estate that may serve an override: the origin of `FRONTEND_URL`'s first entry must be this host. */
export const DEV_ESTATE_HOST = 'dev.canari-emse.fr';

/** One account's explicit dev avatar: the bytes, their type, and a validator derived from the bytes. */
export interface DevAvatar {
  readonly body: Buffer;
  readonly contentType: string;
  readonly etag: string;
}

const SUBJECT_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const FILE_NAME = /^[a-z0-9][a-z0-9-]{0,63}\.(png|jpg|webp)$/;
const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** True when `frontendUrl`'s first origin is the dev estate's canonical one. */
export function isDevEstate(frontendUrl: string | undefined): boolean {
  const first = (frontendUrl ?? '').split(',')[0]?.trim();
  if (!first) return false;
  try {
    return new URL(first).hostname === DEV_ESTATE_HOST;
  } catch {
    return false;
  }
}

/**
 * The explicit per-account avatars the DEV estate serves instead of the gallery's (dev has no gallery,
 * so every face there was an initials circle).
 *
 * NOT A FALLBACK. An account is listed here by id, or it is not, and a listed account's avatar is
 * this file, always. The directory holds an `index.json` (`{ "<user id>": "<file>.png" }`) and the
 * files it names; `extra` is a second `id=file` list for accounts whose id the repository does not
 * carry (the bench accounts, named by the dev box's own environment).
 *
 * IMPOSSIBLE TO ENABLE ELSEWHERE: a directory named on any estate whose `FRONTEND_URL` is not the dev
 * one REFUSES TO BOOT (this throws from the service constructor). Production's compose file does not
 * set the variable at all, and the image that carries the files is inert without it.
 *
 * @param dir  `DEV_AVATAR_OVERRIDE_DIR`; empty means the feature is off
 * @param extra  `DEV_AVATAR_OVERRIDE_EXTRA`, `id=file,id=file`
 * @param frontendUrl  `FRONTEND_URL`, the estate's identity
 * @param read  injectable for tests
 */
export function loadDevAvatars(
  dir: string | undefined,
  extra: string | undefined,
  frontendUrl: string | undefined,
  read: (path: string) => Buffer = readFileSync
): Map<string, DevAvatar> {
  const out = new Map<string, DevAvatar>();
  if (!dir) return out;
  if (!isDevEstate(frontendUrl)) {
    throw new Error(
      `DEV_AVATAR_OVERRIDE_DIR is set but FRONTEND_URL is not the dev estate (${DEV_ESTATE_HOST}): ` +
        'refusing to boot. This override exists on the dev estate only.'
    );
  }
  // A Map, never a plain object: an id such as `__proto__` is an ordinary key here, never silently lost.
  const listed = new Map<string, string>(
    Object.entries(
      JSON.parse(read(join(dir, 'index.json')).toString('utf8')) as Record<string, string>
    )
  );
  for (const pair of (extra ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const eq = pair.indexOf('=');
    const id = pair.slice(0, eq);
    const file = pair.slice(eq + 1);
    // Exactly `id=file`: no `=`, or a second one, is a typo to refuse loudly, not to truncate.
    if (eq < 0 || file.includes('=')) {
      throw new Error(
        `dev avatar override: malformed EXTRA entry ${JSON.stringify(pair)}, expected id=file`
      );
    }
    listed.set(id, file);
  }
  for (const [id, file] of listed) {
    if (!SUBJECT_ID.test(id) || !FILE_NAME.test(file)) {
      throw new Error(
        `dev avatar override: refused entry ${JSON.stringify(id)} -> ${JSON.stringify(file)}`
      );
    }
    const body = read(join(dir, file));
    // A validator that is a digest of the whole body: a changed file changes it, nothing else does.
    const etag = `"dev-${createHash('sha256').update(body).digest('hex')}"`;
    out.set(id, { body, contentType: TYPES[file.split('.')[1]], etag });
  }
  return out;
}
