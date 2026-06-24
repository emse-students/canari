import type { GroupMeta } from '$lib/mls-client/IMlsService';
import type { ConversationLifecycle } from '$lib/types';

export type { ConversationLifecycle };

/**
 * Normalise une valeur de cycle de vie chargee depuis le stockage. Tolere les anciennes lignes
 * (avant ce champ) qui ne portaient qu'un booleen `isReady` : `true -> active`, sinon `pending`
 * (l'ancien modele ne persistait jamais l'etat `removed`). Toute valeur inconnue retombe sur
 * `pending` (le plus sur : declenche une recovery, jamais une purge ni un envoi).
 */
export function normalizeConversationLifecycle(
  raw: unknown,
  legacyIsReady?: boolean
): ConversationLifecycle {
  if (raw === 'active' || raw === 'pending' || raw === 'removed') return raw;
  return legacyIsReady ? 'active' : 'pending';
}

/**
 * Cycle de vie d'un groupe : SOURCE DE VERITE UNIQUE et logique de decision centralisee.
 *
 * Contexte (cf. audit) : la question "ce groupe local est-il encore reel, et que dois-je en
 * faire ?" etait re-implementee dans 3-4 reconciliateurs (discovery, sync-on-connect, requestReAdd)
 * avec des gardes divergentes -> chaque divergence = un bug (fantome indeletable, "statut
 * incertain" sur un groupe pourtant supprime, etc.). Ce module factorise :
 *   1. `classifyServerStatus` : transforme la reponse ambigue du serveur en un etat explicite.
 *   2. `decideAbsentGroupFate` : reducteur PUR qui mappe (etat serveur + signaux locaux) -> action.
 * Tous les reconciliateurs consomment ces deux fonctions, donc une seule logique a maintenir.
 *
 * Rappel des 3 etats serveur d'un groupe (table `dm_groups`) :
 *  - `active`    : ligne presente, `deletedAt` null -> le groupe vit.
 *  - `tombstone` : ligne presente, `deletedAt` non-null -> supprime par un pair (dure 90j, cron).
 *  - `absent`    : plus aucune ligne -> jamais cree, hard-purge apres 90j, ou base videe.
 * Plus un 4e etat cote client : `unknown` (echec reseau) -> on ne purge JAMAIS sur un doute.
 */

/** Etat serveur explicite d'un groupe (leve l'ambiguite `null` de `getGroupMeta`/`getGroupServerStatus`). */
export type GroupServerStatus =
  | { kind: 'active'; meta: GroupMeta }
  | { kind: 'tombstone'; meta: GroupMeta }
  | { kind: 'absent' }
  | { kind: 'unknown' };

/**
 * Convertit la valeur brute de `IMlsService.getGroupServerStatus` (`'absent' | 'error' | GroupMeta`)
 * en {@link GroupServerStatus}. Un `GroupMeta` avec `deletedAt` non-null est un tombstone.
 */
export function classifyServerStatus(raw: 'absent' | 'error' | GroupMeta): GroupServerStatus {
  if (raw === 'absent') return { kind: 'absent' };
  if (raw === 'error') return { kind: 'unknown' };
  return raw.deletedAt ? { kind: 'tombstone', meta: raw } : { kind: 'active', meta: raw };
}

/**
 * Action a appliquer a une conversation locale apres reconciliation.
 *  - `keep`        : ne rien faire (groupe encore valide, ou doute -> on conserve).
 *  - `purge`       : retirer la conversation (et l'etat MLS) -> le groupe n'existe plus DU TOUT.
 *  - `markRemoved` : passer la conversation en `removed` (banniere "supprime/exclu", suppression manuelle).
 */
export type ConversationFate = {
  action: 'keep' | 'purge' | 'markRemoved';
  /** Motif lisible (pour les logs de diagnostic). */
  reason: string;
};

/** Signaux d'entree pour {@link decideAbsentGroupFate}. */
export interface AbsentGroupFateInput {
  /** Le groupe est un successeur tombstone connu (lignee de reboot) -> conserve, la migration gere. */
  isKnownSuccessor: boolean;
  /** Etat de cycle de vie actuel de la conversation locale. */
  lifecycle: ConversationLifecycle;
  /** Etat serveur resolu (cf. `classifyServerStatus`). */
  serverStatus: GroupServerStatus;
  /**
   * Re-validation anti-race de NOTRE membership user-level (`dm_group_members`), utilisee
   * uniquement quand le groupe est `active` mais absent de notre snapshot `getUserGroups` :
   *  - `true`  : on est toujours membre -> snapshot perime, on garde la conv active.
   *  - `false` : on n'est plus membre -> exclusion reelle -> banniere.
   *  - `null`  : impossible a determiner (reseau) -> on conserve dans le doute.
   * Non pertinent (et ignore) pour les autres etats serveur.
   */
  isStillUserMember: boolean | null;
}

/**
 * Reducteur PUR : decide du sort d'une conversation locale ABSENTE de notre membership active
 * (`getUserGroups`). C'est l'ancien bloc `if (!serverGroupIds.has(…))` de `discoverMissingGroups`,
 * extrait tel quel pour etre teste exhaustivement et partage.
 *
 * Principe directeur : la source de verite est le SERVEUR pour l'existence, SAUF les survivants
 * purement locaux (supprime-par-un-pair / exclusion -> banniere ; dismiss manuel -> purge ailleurs)
 * qui restent jusqu'a suppression manuelle. On ne purge JAMAIS sur un doute reseau.
 */
export function decideAbsentGroupFate(input: AbsentGroupFateInput): ConversationFate {
  // Successeur tombstone : la migration de lignee s'en occupe, on ne touche pas.
  if (input.isKnownSuccessor) {
    return { action: 'keep', reason: 'successeur tombstone (migration en charge)' };
  }
  // Deja `removed` : reste jusqu'a SUPPRESSION MANUELLE locale (regles 2 & 4), quoi qu'il advienne
  // cote serveur (meme apres hard-purge du tombstone). Jamais re-interroge ni re-purge.
  if (input.lifecycle === 'removed') {
    return { action: 'keep', reason: 'deja removed (suppression manuelle)' };
  }

  switch (input.serverStatus.kind) {
    case 'absent':
      // Plus aucune ligne dm_groups : le groupe n'existe plus du tout (regle 1) -> purge.
      return { action: 'purge', reason: 'absent de dm_groups (confirme)' };

    case 'unknown':
      // Echec reseau : indiscernable d'un groupe supprime -> on ne purge jamais sur un doute.
      return { action: 'keep', reason: 'statut serveur incertain (reseau)' };

    case 'tombstone':
      // Supprime par un pair (regle 2). Un simple placeholder (pending) est conserve tel quel.
      return input.lifecycle === 'active'
        ? { action: 'markRemoved', reason: 'supprime (tombstone) cote serveur' }
        : { action: 'keep', reason: 'placeholder tombstone (pending)' };

    case 'active':
      // Vivant cote serveur mais absent de notre snapshot getUserGroups, qui peut etre perime sur
      // un groupe qu'on vient de creer/rejoindre. On revalide la membership reelle avant de marquer.
      if (input.isStillUserMember === null) {
        return { action: 'keep', reason: 'membres indisponibles (doute)' };
      }
      if (input.isStillUserMember) {
        return { action: 'keep', reason: 'vivant et toujours membre (snapshot perime)' };
      }
      // Plus membre d'un groupe vivant -> exclusion reelle (regle 4).
      return input.lifecycle === 'active'
        ? { action: 'markRemoved', reason: 'exclu (plus membre) du groupe vivant' }
        : { action: 'keep', reason: 'placeholder exclu (pending)' };
  }
}
