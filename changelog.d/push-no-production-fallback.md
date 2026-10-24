### Fixed - the push service no longer falls back to the production origin

The root layout started push registration with `historyBaseUrl || DEFAULT_PUBLIC_APP_ORIGIN`; the base URL is never empty, so the production fallback was dead code that could only ever have sent a dev or local build's registration to production. It now passes the delivery base URL alone, like every other caller (`pushServiceBaseUrl.test.ts`).
