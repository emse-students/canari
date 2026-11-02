/**
 * An in-memory Redis holding sets, hashes and lists - only the commands an account erasure's Redis
 * sweep uses, with their real paging: `SCAN`, `SSCAN` and `HSCAN` answer `pageSize` items per call
 * and a cursor, so a caller that reads one page only is caught by a test.
 *
 * `MATCH` is Redis's glob: `*`, `?` and a backslash escape (what a caller escaping an id relies on).
 */
export interface MemoryRedis {
  sets: Map<string, Set<string>>;
  hashes: Map<string, Map<string, string>>;
  lists: Map<string, string[]>;
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
  sscan(key: string, cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
  hscan(key: string, cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
  smembers(key: string): Promise<string[]>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  hset(key: string, ...fieldValues: string[]): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lrem(key: string, count: number, value: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
}

/** Redis glob to a RegExp: `*`, `?`, and `\x` for a literal `x`. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) {
      out += glob[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (c === '*') out += '.*';
    else if (c === '?') out += '.';
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** The `MATCH` argument of a scan call as a predicate, or one accepting everything. */
function matcherOf(args: (string | number)[]): (value: string) => boolean {
  const i = args.findIndex((a) => String(a).toUpperCase() === 'MATCH');
  if (i < 0) return () => true;
  const re = globToRegExp(String(args[i + 1]));
  return (value) => re.test(value);
}

/** One page of `items` from `cursor`, Redis-shaped: the next cursor is '0' once the end is reached. */
function page<T>(items: T[], cursor: string, size: number): [string, T[]] {
  const from = Number(cursor);
  const next = from + size;
  return [next >= items.length ? '0' : String(next), items.slice(from, next)];
}

/** A fresh in-memory Redis answering `pageSize` items per scan call. */
export function memoryRedis(pageSize = 2): MemoryRedis {
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Map<string, string>>();
  const lists = new Map<string, string[]>();
  const allKeys = () => [...sets.keys(), ...hashes.keys(), ...lists.keys()].sort();
  return {
    sets,
    hashes,
    lists,
    async scan(cursor, ...args) {
      const [next, keys] = page(allKeys(), cursor, pageSize);
      const match = matcherOf(args);
      return [next, keys.filter((k) => match(k))];
    },
    async sscan(key, cursor, ...args) {
      const [next, members] = page([...(sets.get(key) ?? [])].sort(), cursor, pageSize);
      const match = matcherOf(args);
      return [next, members.filter((m) => match(m))];
    },
    async hscan(key, cursor, ...args) {
      const [next, fields] = page([...(hashes.get(key)?.keys() ?? [])].sort(), cursor, pageSize);
      const match = matcherOf(args);
      return [
        next,
        fields.filter((f) => match(f)).flatMap((f) => [f, hashes.get(key)?.get(f) ?? '']),
      ];
    },
    async smembers(key) {
      return [...(sets.get(key) ?? [])];
    },
    async sadd(key, ...members) {
      const set = sets.get(key) ?? new Set<string>();
      sets.set(key, set);
      const before = set.size;
      members.forEach((m) => set.add(m));
      return set.size - before;
    },
    async srem(key, ...members) {
      const set = sets.get(key);
      if (!set) return 0;
      const before = set.size;
      members.forEach((m) => set.delete(m));
      if (set.size === 0) sets.delete(key);
      return before - (sets.get(key)?.size ?? 0);
    },
    async hset(key, ...fieldValues) {
      const hash = hashes.get(key) ?? new Map<string, string>();
      hashes.set(key, hash);
      let added = 0;
      for (let i = 0; i + 1 < fieldValues.length; i += 2) {
        if (!hash.has(fieldValues[i])) added++;
        hash.set(fieldValues[i], fieldValues[i + 1]);
      }
      return added;
    },
    async hdel(key, ...fields) {
      const hash = hashes.get(key);
      if (!hash) return 0;
      let removed = 0;
      fields.forEach((f) => (removed += hash.delete(f) ? 1 : 0));
      if (hash.size === 0) hashes.delete(key);
      return removed;
    },
    async rpush(key, ...values) {
      const list = lists.get(key) ?? [];
      lists.set(key, list);
      list.push(...values);
      return list.length;
    },
    async lrange(key, start, stop) {
      const list = lists.get(key) ?? [];
      return list.slice(start, stop === -1 ? undefined : stop + 1);
    },
    async lrem(key, _count, value) {
      const list = lists.get(key);
      if (!list) return 0;
      const kept = list.filter((v) => v !== value);
      const removed = list.length - kept.length;
      if (kept.length === 0) lists.delete(key);
      else lists.set(key, kept);
      return removed;
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys) {
        n += sets.delete(k) || hashes.delete(k) || lists.delete(k) ? 1 : 0;
      }
      return n;
    },
  };
}
