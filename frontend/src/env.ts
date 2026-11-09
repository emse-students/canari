import { defineEnvVars } from '@sveltejs/kit/env';

/**
 * The server-side environment `src/hooks.server.ts` and the SEO chain read, declared the SvelteKit 3
 * way (it replaced `$env/dynamic/private`). Read at RUNTIME, never inlined, and every one is
 * OPTIONAL on purpose: the callers in `lib/seo/internalApi.ts` own the defaults, and a bare local
 * `bun run dev` or a unit test sets none of them. An unset variable is `undefined`, exactly what
 * `env.X` was.
 */
export const variables = defineEnvVars({
  SOCIAL_SERVICE_URL: { schema: (value) => value },
  CORE_SERVICE_URL: { schema: (value) => value },
  DELIVERY_SERVICE_URL: { schema: (value) => value },
  INTERNAL_SECRET: { schema: (value) => value },
});
