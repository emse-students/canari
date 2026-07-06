/**
 * Serialise les mutations de la Map reactive `conversations` PAR groupId (audit H3).
 *
 * Contexte : deux flux concurrents lisaient puis reecrivaient `conversations` autour de plusieurs
 * `await` reseau/stockage, s'entrelacant sur le meme groupId (ex. deux receptions de Welcome, ou
 * un Welcome et une reconciliation de doublons re-cle la meme conversation directe). Si l'un
 * s'intercale entre la LECTURE et l'ECRITURE de l'autre, on obtient un ecrasement des messages en
 * memoire (lost update). `runExclusiveForGroup` garantit qu'une seule section critique par groupId
 * tourne a la fois.
 *
 * INVARIANT ANTI-DEADLOCK : une section verrouillee ici ne doit JAMAIS acquerir le verrou MLS
 * async (`runUnderMlsLock`). Les sections concernees ne touchent que la Map et le stockage
 * (SQLite/IndexedDB) ; `forgetGroup` est synchrone (ne prend pas le verrou MLS). Comme aucun
 * detenteur de CE verrou n'attend le verrou MLS, il ne peut pas y avoir de cycle d'attente avec
 * un appelant qui tient le verrou MLS et attend ce verrou-ci (ex. `upsertConversation`).
 */
const groupChains = new Map<string, Promise<unknown>>();

/**
 * Execute `fn` en exclusion mutuelle avec toute autre section passee pour le MEME `groupId`.
 * Les groupes differents ne se bloquent pas entre eux. La chaine est nettoyee quand elle se vide
 * (pas de fuite memoire pour les groupes inactifs).
 */
export function runExclusiveForGroup<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
  const prev = groupChains.get(groupId) ?? Promise.resolve();
  // `then(fn, fn)` : on enchaine quel que soit le sort du precedent (succes OU echec) pour ne
  // jamais bloquer la file sur une erreur d'une section anterieure.
  const run = prev.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  groupChains.set(groupId, settled);
  void settled.then(() => {
    // Ne supprimer que si aucune section plus recente n'a ete enchainee entre-temps.
    if (groupChains.get(groupId) === settled) groupChains.delete(groupId);
  });
  return run;
}
