import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  type Provider,
  SetMetadata,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { isUUID } from 'class-validator';

/**
 * What a path parameter IS, as its route declares it:
 * - `uuid`: it names a row whose key is a Postgres `uuid`, so anything else is refused before any
 *   query is built;
 * - `opaque`: it is not a uuid (a user id, a slug) and is passed through as it came. Writing it is
 *   the point: an unvalidated parameter is then a choice someone made, never an omission.
 */
export type RouteParamKind = 'uuid' | 'opaque';

/** A controller's or a handler's declaration: parameter name to kind. */
export type RouteParamKinds = Readonly<Record<string, RouteParamKind>>;

/** Metadata key of {@link RouteParams}. */
export const ROUTE_PARAMS_KEY = 'route_params';

/**
 * Declares the kind of the path parameters of a controller (every route of the class) or of one
 * handler (which adds to, and wins over, its class).
 *
 * WHY A DECLARATION AND NOT A PIPE ON EACH `@Param`: Nest runs guards BEFORE pipes, and a guard
 * that reads `request.params` to ask the database a question meets the raw string first. A
 * malformed id then fails inside the guard as a `QueryFailedError`, a 500, whatever pipe the
 * handler carries. {@link RouteParamsGuard} is global, so it runs before every other guard, and
 * this declaration is what it reads. `route-params.coverage.spec.ts` fails on a path parameter no
 * declaration names, and on a declaration naming a parameter no route has.
 */
export const RouteParams = (kinds: RouteParamKinds) => SetMetadata(ROUTE_PARAMS_KEY, kinds);

/**
 * The declaration that applies to one handler: its class's, then its own on top.
 *
 * @param reflector Nest's metadata reader
 * @param controller the controller class
 * @param handler the route handler
 */
export function routeParamKindsOf(
  reflector: Reflector,
  controller: object,
  handler: object
): RouteParamKinds {
  return {
    ...reflector.get<RouteParamKinds | undefined>(ROUTE_PARAMS_KEY, controller as never),
    ...reflector.get<RouteParamKinds | undefined>(ROUTE_PARAMS_KEY, handler as never),
  };
}

/**
 * Refuses, with a 400 naming the parameter, a request whose path carries something else than a
 * uuid where its route declared one. It reads the declaration and the path, never the database.
 */
@Injectable()
export class RouteParamsGuard implements CanActivate {
  private readonly logger = new Logger(RouteParamsGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const kinds = routeParamKindsOf(this.reflector, context.getClass(), context.getHandler());
    const params: Record<string, unknown> = context.switchToHttp().getRequest().params ?? {};
    for (const [name, kind] of Object.entries(kinds)) {
      if (kind !== 'uuid' || !(name in params)) continue;
      if (!isUUID(params[name])) {
        this.logger.debug(
          `[ROUTE_PARAMS] ${context.getClass().name}.${context.getHandler().name}: "${name}" is not a uuid - 400`
        );
        throw new BadRequestException(`Validation failed (uuid is expected) for "${name}"`);
      }
    }
    return true;
  }
}

/**
 * The guard as the GLOBAL guard of an application: registered through `APP_GUARD`, it runs before
 * the guards a controller or a handler names. `AppModule` provides it, and so does any spec that
 * boots real routes to observe that order.
 */
export const ROUTE_PARAMS_GUARD: Provider = { provide: APP_GUARD, useClass: RouteParamsGuard };
