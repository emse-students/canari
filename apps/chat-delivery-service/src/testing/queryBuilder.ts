/**
 * Chainable stubs for the TypeORM query builder, for unit tests that never touch a database.
 *
 * **WRITTEN BECAUSE A HAND-ROLLED CHAIN PINS THE SHAPE OF A QUERY AND NOTHING ELSE.** The pool
 * stub in `devices.controller.static-fallback.spec.ts` spelled out
 * `where -> orderBy -> limit -> setLock -> setOnLocked -> getOne` as nested object literals, so
 * adding one `andWhere` to the resolver broke two tests that had nothing to say about filtering -
 * `where(...).andWhere is not a function`, twice, in a file about last-resort reuse. The failure
 * was noise: the test could not have been wrong, because it never asserted anything about the
 * chain.
 *
 * These stubs answer any builder method by returning themselves, and only the TERMINAL call
 * (`getOne`, `getMany`, `getRawOne`, `getRawMany`, `getCount`, `execute`) produces a value. A test
 * that wants to assert about the query says so explicitly, by reading `calls`.
 */

/** Every terminal a stub can answer, and what it answers with. */
export interface QueryBuilderResult {
  getOne?: unknown;
  getMany?: unknown[];
  getRawOne?: unknown;
  getRawMany?: unknown[];
  getCount?: number;
  execute?: unknown;
}

/** What a stub recorded: every non-terminal method call, in order, with its arguments. */
export interface QueryBuilderCalls {
  calls: { method: string; args: unknown[] }[];
}

const TERMINALS = new Set(['getOne', 'getMany', 'getRawOne', 'getRawMany', 'getCount', 'execute']);

/**
 * A query builder that accepts any chain and answers the terminals it is given.
 *
 * Absent terminals answer the empty form of their own kind (`null`, `[]`, `0`, `{ affected: 0 }`),
 * which is what "the database holds nothing" looks like - the default a test should not have to
 * spell out.
 */
export function stubQueryBuilder<T = unknown>(
  result: QueryBuilderResult = {}
): T & QueryBuilderCalls {
  const calls: { method: string; args: unknown[] }[] = [];
  const target = { calls } as QueryBuilderCalls;
  const proxy: unknown = new Proxy(target, {
    get(_t, prop: string | symbol) {
      if (prop === 'calls') return calls;
      if (typeof prop !== 'string') return undefined;
      if (TERMINALS.has(prop)) {
        return async (...args: unknown[]) => {
          calls.push({ method: prop, args });
          if (prop in result) return result[prop as keyof QueryBuilderResult];
          if (prop === 'getMany' || prop === 'getRawMany') return [];
          if (prop === 'getCount') return 0;
          if (prop === 'execute') return { affected: 0 };
          return null;
        };
      }
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        return proxy;
      };
    },
  });
  return proxy as T & QueryBuilderCalls;
}

/**
 * A `DataSource` whose `transaction` hands out a manager backed by one stubbed builder.
 *
 * The resolver pops the one-time pool inside a transaction, so a test about what it serves needs a
 * manager, a repository and a builder before it can say anything at all. `served` is the row the
 * locked SELECT finds - `null` for an empty pool.
 */
export function stubPool(served: unknown = null) {
  const builder = stubQueryBuilder({ getOne: served });
  const del = jest.fn();
  return {
    builder,
    delete: del,
    transaction: jest.fn(async (fn: (m: unknown) => unknown) =>
      fn({ getRepository: () => ({ createQueryBuilder: () => builder }), delete: del })
    ),
  };
}
