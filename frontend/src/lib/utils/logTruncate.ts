/**
 * Troncature des identifiants longs dans les logs, pour un affichage compact et
 * lisible. Réplique web de la logique appliquée côté Android par test_adb.py,
 * afin que les logs des deux plateformes aient le même format condensé.
 */

/** UUID canonique (8-4-4-4-12), insensible à la casse. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Suite hexadécimale d'au moins 16 caractères (userId 64-hex, clés, hashes SHA-256…). */
const LONG_HEX_RE = /\b[0-9a-f]{16,}\b/gi;

let installed = false;

/**
 * Réduit les UUIDs et les longues suites hexadécimales (≥ 16 caractères) à leurs
 * 8 premiers caractères suivis de " … ". Les hex courts (epochs, compteurs,
 * couleurs CSS) sont laissés intacts.
 */
export function truncateLogIds(text: string): string {
  return text
    .replace(UUID_RE, (m) => m.slice(0, 8) + '…')
    .replace(LONG_HEX_RE, (m) => m.slice(0, 8) + '…');
}

/**
 * Installe une troncature globale des identifiants sur toutes les méthodes
 * `console.*`. Les arguments string sont condensés via {@link truncateLogIds} ;
 * les autres (objets, erreurs) passent inchangés. Idempotent : ne wrappe la
 * console qu'une seule fois quel que soit le nombre d'appels.
 *
 * Couvre d'un seul point d'entrée tous les logs web - `[API]`, `[WS]`,
 * `appendLog`, `[RUST::INFO]`… - sans toucher aux dizaines de sites d'appel.
 */
export function installConsoleIdTruncation(): void {
  if (installed) return;
  installed = true;

  const methods = ['log', 'debug', 'info', 'warn', 'error'] as const;
  for (const method of methods) {
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    console[method] = (...args: unknown[]): void =>
      original(...args.map((a) => (typeof a === 'string' ? truncateLogIds(a) : a)));
  }
}
