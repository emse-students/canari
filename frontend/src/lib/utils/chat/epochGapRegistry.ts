/**
 * Registre process-global des groupes en gap d'epoch non resolu (`msg_epoch > group_epoch`).
 *
 * Un groupe entre dans le registre quand le pipeline de messages recoit une frame qu'il ne
 * peut pas dechiffrer parce que son etat local est en retard d'epoch ; il en sort des qu'un
 * commit avance reellement l'epoch (gap resorbe) ou apres escalade forget+re-Welcome.
 *
 * Pourquoi un module partage plutot qu'une Map locale au handler : l'outbox (`isGroupHealthy`)
 * doit pouvoir consulter cet etat pour NE PAS envoyer un message applicatif dans un groupe
 * qu'on sait en retard - sinon le ciphertext est chiffre a une epoch perimee et les
 * destinataires (a jour) ne peuvent pas le dechiffrer. Le pipeline et l'outbox vivent dans
 * des modules distincts ; un singleton evite de threader la Map a travers toutes les couches.
 *
 * Il n'existe qu'une session active par process (l'etat MLS WASM/Tauri est lui-meme global),
 * donc un Map module-level est sans risque de collision entre sessions.
 */

/** Timestamp (ms) du 1er gap d'epoch non resolu, par groupe. */
const epochGapSince = new Map<string, number>();

/**
 * Marque un groupe comme entre en gap d'epoch s'il ne l'etait pas deja, et renvoie le
 * timestamp (ms) du debut du gap (existant ou nouvellement pose). Sert a mesurer la duree
 * du gap pour decider de l'escalade.
 */
export function markEpochGap(groupId: string): number {
  const existing = epochGapSince.get(groupId);
  if (existing !== undefined) return existing;
  const now = Date.now();
  epochGapSince.set(groupId, now);
  return now;
}

/** Renvoie le timestamp (ms) de debut du gap pour ce groupe, ou `undefined` s'il n'est pas en gap. */
export function getEpochGapSince(groupId: string): number | undefined {
  return epochGapSince.get(groupId);
}

/** Efface l'etat de gap d'un groupe (gap resorbe par un commit, ou escalade declenchee). */
export function clearEpochGap(groupId: string): void {
  epochGapSince.delete(groupId);
}

/** True si le groupe est actuellement en gap d'epoch non resolu (donc non sendable). */
export function isInEpochGap(groupId: string): boolean {
  return epochGapSince.has(groupId);
}

/**
 * Vide tout le registre. Appele a l'initialisation d'une session (setup du handler de messages)
 * pour repartir d'un etat propre : un gap non resolu d'une session precedente (logout sans
 * resorption) ne doit pas survivre au re-login et bloquer indefiniment l'outbox - les messages
 * applicatifs ne resorbent pas un gap (seul un commit le fait), donc une entree perimee ne
 * s'effacerait jamais d'elle-meme sans nouvelle frame indechiffrable declenchant l'escalade.
 */
export function resetEpochGapRegistry(): void {
  epochGapSince.clear();
}
