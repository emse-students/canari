import { MOBILE_APP_PACKAGE } from './appSiteAssociation';

/*
 * The two store listings, in a module with NO runtime dependency: the server's in-app browser gate
 * reaches them through `openInApp.ts`, and the SSR image ships `build/` without `node_modules`, so
 * anything here that imported a package (as `appVersion.ts` imports `@tauri-apps/plugin-os`) would
 * crash the server at start, as it did on the v1.8.2-alpha.5 dev deploy. The production build's
 * assertion starts the server with no `node_modules` and fails on it
 * (docs/wiki/frontend/architecture.md#the-server-half-imports-no-package-2026-11-26).
 */

/**
 * Google Play listing URL for the Android build.
 *
 * A public, permanent URL - deliberately a constant rather than build-time config, so
 * an unset variable can never mean "update path silently dead". The `https://` form is
 * used over `market://details?id=...` because the Play Store app intercepts it on
 * device, it stays valid in a desktop browser, and it needs no `opener` ACL change.
 */
export const PLAY_STORE_URL = `https://play.google.com/store/apps/details?id=${MOBILE_APP_PACKAGE}`;

/**
 * App Store listing URL for the iOS build.
 *
 * Geo-neutral on purpose (no `/us/` path segment): Apple redirects to the viewer's own
 * regional storefront. iOS updates always go through the App Store - there is no
 * sideloadable binary the way Android has its APK - so this is the only meaningful
 * update target on iOS.
 */
export const APP_STORE_URL = 'https://apps.apple.com/app/id6793060521';
