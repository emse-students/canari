import type { IMlsService } from './IMlsService';

/**
 * Publishes fresh KeyPackages if the pool is below the recommended threshold.
 *
 * The pool logic (quota, fallback vs OTKPs) lives in each implementation's `generateKeyPackage`
 * (WebMlsService / TauriMlsService). This module exposes a single entry point for the connection
 * layer and the helpers.
 */
export async function replenishKeyPackages(
  mlsService: IMlsService,
  deviceKeyB64: string
): Promise<void> {
  await mlsService.generateKeyPackage(deviceKeyB64);
}
