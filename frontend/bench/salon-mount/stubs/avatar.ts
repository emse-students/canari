/** Avatars, answered from memory: no photo, so the initials are drawn as on a cold cache. */
export * from '../../../src/lib/utils/userAvatarCache';

/** The real one fetches the photo; here every member has none. */
export async function resolveUserAvatarDisplay(): Promise<{ kind: 'none' }> {
  return { kind: 'none' };
}

/** Nothing was taken from the pool, so nothing is given back. */
export function releaseUserAvatarDisplay(): void {}
