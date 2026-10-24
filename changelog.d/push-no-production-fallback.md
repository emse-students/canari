### Fixed - no production fallback for the push service, and the production names stay in one module

The root layout started push registration with `historyBaseUrl || DEFAULT_PUBLIC_APP_ORIGIN`, a dead fallback that could only ever have sent a dev or local build to production; it now passes the delivery base URL alone. `siteOrigin` and `publicAppOrigin` share one `canonicalPublicAppOrigin`, so no module but `publicAppUrl.ts` reads the production constants (`publicAppUrl.test.ts`).
