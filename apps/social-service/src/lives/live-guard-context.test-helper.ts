import type { ExecutionContext } from '@nestjs/common';

/** A request context for `LiveEnabledGuard`, carrying `version` in the client-version header (null = no header). */
export function guardContext(version: string | null = '1.5.4'): ExecutionContext {
  const headers: Record<string, string> =
    version === null ? {} : { 'x-canari-client-version': version };
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}
