/// <reference types="jest" />

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Garde-fou DI infra-free : toute entite injectee via `@InjectRepository(Entity)` DOIT etre
 * enregistree dans un `TypeOrmModule.forFeature([…])`, sinon le provider `<Entity>Repository`
 * n'existe pas et le bootstrap NestJS jette `UnknownDependenciesException` AU DEMARRAGE (erreur
 * runtime invisible a `tsc` et aux specs unitaires qui ne compilent pas `AppModule`).
 *
 * Ce test relit les sources (pas de DB/Redis) : il aurait attrape l'oubli de `UserDismissedGroup`
 * dans `forFeature` qui a mis le service en crash-loop et casse la CD.
 */

const SRC_ROOT = __dirname;

/** Liste recursivement les fichiers `.ts` de src (hors specs, declarations et node_modules). */
function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listSourceFiles(full, acc);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/** Identifiant TS valide (filtre les commentaires/jetons parasites dans un array). */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

describe('AppModule - enregistrement DI des repositories TypeORM', () => {
  const files = listSourceFiles(SRC_ROOT);

  it('chaque @InjectRepository(Entity) est present dans un TypeOrmModule.forFeature([…])', () => {
    // 1. Toutes les entites injectees via @InjectRepository(X), avec le fichier de la 1ere occurrence.
    const injectedAt = new Map<string, string>();
    const injectRe = /@InjectRepository\(\s*([A-Za-z0-9_]+)\s*\)/g;
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = injectRe.exec(src)) !== null) {
        if (!injectedAt.has(m[1])) injectedAt.set(m[1], file);
      }
    }

    // 2. Toutes les entites enregistrees dans un forFeature([…]) (n'importe quel module).
    const registered = new Set<string>();
    const forFeatureRe = /forFeature\(\s*\[([\s\S]*?)\]/g;
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = forFeatureRe.exec(src)) !== null) {
        for (const token of m[1].split(',').map((s) => s.trim())) {
          if (IDENTIFIER.test(token)) registered.add(token);
        }
      }
    }

    // 3. Toute entite injectee mais non enregistree casserait le bootstrap.
    const missing = [...injectedAt.keys()].filter((e) => !registered.has(e));
    if (missing.length > 0) {
      const detail = missing.map((e) => `  - ${e} (injecte dans ${injectedAt.get(e)})`).join('\n');
      throw new Error(
        `Entite(s) injectee(s) via @InjectRepository absente(s) de TypeOrmModule.forFeature ` +
          `(bootstrap NestJS KO au demarrage):\n${detail}`
      );
    }

    // Sanity : on a bien detecte des injections (sinon le scan est casse et ne protege rien).
    expect(injectedAt.size).toBeGreaterThan(0);
  });
});
