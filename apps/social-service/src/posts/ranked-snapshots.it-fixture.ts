import type { RedisService } from '../common/redis/redis.service';
import { RANKED_SNAPSHOT_READ_SCRIPT, RANKED_SNAPSHOT_WRITE_SCRIPT } from './for-you-feed';

/**
 * AN IN-MEMORY REDIS FOR THE RANKED SNAPSHOTS, for the specs (never built: `*.it-fixture.ts`). It
 * runs the two scripts of `for-you-feed.ts` by their meaning - the hash per (list, reader), the
 * newest N fields kept, the lifetime renewed on a hit - plus the `get`/`setex`/`incr` the feed
 * cache uses. `failReads` / `failWrites` make the scripts throw, as an unreachable Redis does.
 * The real scripts were run once against `redis:7` (docs/wiki/frontend/modules/posts.md).
 */
export function fakeRankedRedis() {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const expiries: { key: string; ttl: number }[] = [];
  const state = { failReads: false, failWrites: false };
  const redis = {
    get: (key: string) => Promise.resolve(strings.get(key) ?? null),
    mget: (...keys: string[]) => Promise.resolve(keys.map((k) => strings.get(k) ?? null)),
    setex: (key: string, _ttl: number, value: string) => {
      strings.set(key, value);
      return Promise.resolve();
    },
    incr: (key: string) => {
      const next = Number(strings.get(key) ?? '0') + 1;
      strings.set(key, String(next));
      return Promise.resolve(next);
    },
    evalScript: (script: string, keys: readonly string[], args: readonly (string | number)[]) => {
      const [key] = keys;
      if (script === RANKED_SNAPSHOT_WRITE_SCRIPT) {
        if (state.failWrites) return Promise.reject(new Error('fake redis: write refused'));
        const [field, value, kept, ttl] = args;
        const hash = hashes.get(key) ?? new Map<string, string>();
        hash.set(String(field), String(value));
        const fields = [...hash.keys()].sort();
        const excess = fields.length - Number(kept);
        for (let i = 0; i < excess; i++) hash.delete(fields[i]);
        hashes.set(key, hash);
        expiries.push({ key, ttl: Number(ttl) });
        return Promise.resolve(Math.max(0, excess));
      }
      if (script === RANKED_SNAPSHOT_READ_SCRIPT) {
        if (state.failReads) return Promise.reject(new Error('fake redis: read refused'));
        const [field, ttl] = args;
        const value = hashes.get(key)?.get(String(field)) ?? null;
        if (value !== null) expiries.push({ key, ttl: Number(ttl) });
        return Promise.resolve(value);
      }
      return Promise.reject(new Error('fake redis: unknown script'));
    },
  };
  return { redis: redis as unknown as RedisService, hashes, expiries, state, strings };
}
