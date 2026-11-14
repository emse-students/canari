import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RouteParams, RouteParamsGuard, isUuidShaped } from './route-params';

/** The guard alone: what it refuses, what it lets through, and which declaration wins. */

@RouteParams({ id: 'uuid', userId: 'opaque', kind: 'uuid' })
class Declared {
  plain() {}

  @RouteParams({ kind: 'opaque', itemId: 'uuid' })
  overriding() {}
}

class Undeclared {
  plain() {}
}

const UUID = '0c0f6f0e-2f8e-4d57-9d0b-3a1d5b6c7e8f';

/** A handler as Nest hands it to a guard: the function on the prototype, read without binding it. */
const handlerOf = (cls: { prototype: object }, name: string) =>
  Reflect.get(cls.prototype, name) as object;

function contextOf(cls: object, handler: object, params: unknown): ExecutionContext {
  return {
    getClass: () => cls,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ params }) }),
  } as unknown as ExecutionContext;
}

describe('RouteParamsGuard', () => {
  const guard = new RouteParamsGuard(new Reflector());
  const ask = (cls: object, handler: object, params: unknown) => () =>
    guard.canActivate(contextOf(cls, handler, params));

  it('lets a uuid through and refuses anything else, naming the parameter', () => {
    expect(ask(Declared, handlerOf(Declared, 'plain'), { id: UUID })()).toBe(true);
    for (const id of ['not-a-uuid', '', '42', UUID.slice(0, 23), `${UUID}0`, `{${UUID}}`]) {
      expect(ask(Declared, handlerOf(Declared, 'plain'), { id })).toThrow(BadRequestException);
      expect(ask(Declared, handlerOf(Declared, 'plain'), { id })).toThrow('"id"');
    }
  });

  it('never looks at a parameter declared opaque', () => {
    expect(
      ask(Declared, handlerOf(Declared, 'plain'), { id: UUID, userId: 'a user, not a uuid' })()
    ).toBe(true);
  });

  it('asks nothing of a declared parameter the matched route does not carry', () => {
    expect(ask(Declared, handlerOf(Declared, 'plain'), {})()).toBe(true);
    expect(ask(Declared, handlerOf(Declared, 'plain'), undefined)()).toBe(true);
  });

  it('a handler adds to its class and wins over it', () => {
    const handler = handlerOf(Declared, 'overriding');
    // `kind` is a uuid for the class and opaque for this handler; `itemId` exists only here.
    expect(ask(Declared, handler, { id: UUID, kind: 'a word', itemId: UUID })()).toBe(true);
    expect(ask(Declared, handler, { id: UUID, kind: 'a word', itemId: 'x' })).toThrow('"itemId"');
    expect(ask(Declared, handler, { id: 'x', kind: 'a word', itemId: UUID })).toThrow('"id"');
    expect(ask(Declared, handlerOf(Declared, 'plain'), { id: UUID, kind: 'a word' })).toThrow(
      '"kind"'
    );
  });

  it('a controller with no declaration is left as it was', () => {
    expect(ask(Undeclared, handlerOf(Undeclared, 'plain'), { id: 'anything' })()).toBe(true);
  });
});

describe('isUuidShaped', () => {
  it('accepts every canonical uuid Postgres stores, whatever its version or variant bits', () => {
    for (const id of [
      UUID,
      UUID.toUpperCase(),
      '00000000-0000-0000-0000-000000000000',
      '11111111-1111-1111-1111-111111111111',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '01932c5e-7b1a-7c3d-8e4f-5a6b7c8d9e0f',
    ]) {
      expect({ id, ok: isUuidShaped(id) }).toEqual({ id, ok: true });
    }
  });

  it('refuses what is not the canonical form, and what is not a string', () => {
    for (const id of [
      '',
      'bde',
      UUID.replaceAll('-', ''),
      ` ${UUID}`,
      `${UUID}\n`,
      42,
      null,
      [UUID],
    ]) {
      expect({ id, ok: isUuidShaped(id) }).toEqual({ id, ok: false });
    }
  });
});
