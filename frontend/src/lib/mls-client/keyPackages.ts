import type { IMlsService } from './IMlsService';

/**
 * Publie des KeyPackages frais si le pool est sous le seuil recommandé.
 *
 * La logique de pool (quota, fallback vs OTKPs) est dans `generateKeyPackage`
 * de chaque implémentation (WebMlsService / TauriMlsService). Ce module
 * expose un point d'entrée unique pour la connexion et les helpers.
 */
export async function replenishKeyPackages(mlsService: IMlsService, pin: string): Promise<void> {
  await mlsService.generateKeyPackage(pin);
}
