import { exportBackup, importBackup } from '$lib/backup';
import { fromHex, toHex, saveMlsState, loadMlsState, exportMlsStateAsHex } from '$lib/utils/hex';
import type { IStorage } from '$lib/db';
import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import {
  sendFullHistoryBundle,
  persistMlsStateAfterMutation,
  forgetMlsGroupIfPresent,
  purgeLocalConversationRecord,
  kickStaleLeaf,
  isGroupActiveOnServer,
  handleDuplicateLeafError,
  isSenderForkError,
  parseForkedEpoch,
} from '$lib/utils/chat/groupActions';
import { parseDirectPeerFromName } from '$lib/utils/chat/conversations';
import {
  classifyServerStatus,
  decideAbsentGroupFate,
  type GroupServerStatus,
} from '$lib/utils/chat/groupLifecycle';
import {
  collectKnownSuccessorIds,
  resolveTerminalGroup,
} from '$lib/utils/chat/groupSyncEligibility';
import { isTauriRuntime } from '$lib/utils/openExternal';

/**
 * Process pending device-group invitations.
 *
 * New paradigm: ANY online device of ANY group member can add a pending device.
 * This eliminates deadlocks - the first device to reconnect handles all pending
 * invitations for groups it belongs to.
 *
 * Flow:
 * 1. Fetch all pending invitations from server (devices waiting to join groups this device is in)
 * 2. For each pending device, acquire add-lock → addMember → sendWelcome → update status
 * 3. On WrongEpoch: check if someone else already handled it → skip
 */
export async function processPendingInvitations(params: {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  pin: string;
  conversations: Map<string, Conversation>;
  log: (msg: string) => void;
  /**
   * Recovery d'un groupe dont NOTRE état local est forké en retard (commit rejeté
   * epoch_mismatch). Effectue forget + welcome_request pour rejoindre à l'epoch courante.
   * `minEpoch` (epoch serveur connue) rejette les Welcomes stale d'une branche divergée.
   * Injecté par la couche session (a besoin des timers/conversations de recovery).
   */
  recoverForkedGroup?: (groupId: string, minEpoch?: number) => Promise<void>;
}) {
  const { mlsService, storage, userId, pin, conversations, log, recoverForkedGroup } = params;

  const myDeviceId = mlsService.getDeviceId();

  // 1. Fetch pending invitations for groups where this device is a full member
  let pendingInvitations: Array<{
    id: string;
    userId: string;
    deviceId: string;
    groupId: string;
    status: string;
  }>;
  try {
    pendingInvitations = await mlsService.getPendingInvitations(userId, myDeviceId);
  } catch (e) {
    log(`[PENDING] Erreur récupération invitations: ${e}`);
    return;
  }

  if (pendingInvitations.length === 0) return;

  log(`[PENDING] ${pendingInvitations.length} invitation(s) en attente à traiter`);

  // Group by groupId for sequential processing per group (avoids epoch races within a group)
  const byGroup = new Map<string, typeof pendingInvitations>();
  for (const inv of pendingInvitations) {
    const list = byGroup.get(inv.groupId) ?? [];
    list.push(inv);
    byGroup.set(inv.groupId, list);
  }

  let totalWelcomes = 0;

  for (const [origGroupId, invitations] of byGroup) {
    // Résoudre le terminal avant tout traitement (reboot peut avoir allongé la chaîne).
    const { terminalId: groupId } = await resolveTerminalGroup(mlsService, origGroupId);
    const resolved = groupId;

    // "Prêt pour inviter" = conversation prête ET groupe présent dans le WASM local.
    // Après un forgetGroup de recovery (fork), la conversation reste isReady mais le groupe
    // a quitté le WASM : tenter addMember y lèverait "Groupe introuvable" en boucle. On
    // retombe alors dans la branche non-prêt (welcome_request de recovery déjà en vol).
    const readyForInvites =
      conversations.get(groupId)?.lifecycle === 'active' &&
      mlsService.getLocalGroups().includes(groupId);
    if (!readyForInvites) {
      if (resolved !== origGroupId) {
        // Le successeur terminal existe mais n'est pas encore prêt (Welcome en transit).
        // onGroupReady() déclenchera un nouveau passage dans 500 ms.
        log(
          `[PENDING] ${origGroupId.slice(0, 8)}… → successeur ${resolved.slice(0, 8)}… pas encore prêt - skip`
        );
      } else {
        // Groupe original non prêt localement. Si totalement absent (pas même un
        // placeholder isReady:false), envoyer un welcome_request. Un placeholder indique
        // que le Welcome est peut-être déjà en transit depuis la queue - on ne réenvoie pas.
        const isAbsent = !conversations.has(origGroupId) && !conversations.has(resolved);
        if (isAbsent) {
          const active = await isGroupActiveOnServer(mlsService, userId, resolved);
          if (active === false) {
            log(
              `[PENDING] Groupe ${origGroupId} supprimé ou absent du serveur → nettoyage invitations (${resolved})`
            );
            for (const inv of invitations) {
              mlsService
                .deleteDeviceMembership(inv.userId, inv.deviceId, origGroupId)
                .catch(() => {});
            }
          } else {
            // Groupe présent sur le serveur mais absent du WASM local → welcome_request.
            // Le watchdog de useChatSession escalade vers reboot après 60s si pas de réponse.
            mlsService.sendWelcomeRequest(resolved).catch(() => {});
            log(
              `[PENDING] Groupe ${origGroupId} absent localement → welcome_request envoyé pour ${resolved}`
            );
          }
        } else {
          log(`[PENDING] Groupe ${groupId}: conversation locale non prête - skip`);
        }
      }
      continue;
    }

    if (resolved !== origGroupId) {
      log(`[PENDING] Groupe ${origGroupId} → résolu via chaîne successeurs : ${resolved}`);
    }

    // Acquire distributed lock to prevent concurrent Add commits (TTL par defaut = pire cas
    // mobile : bulk add + Argon2 + commit + Welcomes, cf. MLS_ADD_LOCK_TTL_MS / H1).
    const lockAcquired = await mlsService.acquireAddLock(groupId).catch(() => false);
    if (!lockAcquired) {
      log(`[PENDING] Groupe ${groupId}: verrou tenu par un autre appareil - skip`);
      continue;
    }

    try {
      // ── Ajouter les devices pending ───────────────────────────────────────
      // Seul l'état 'pending' existe désormais (stale supprimé - RFC 9420).
      const currentPending = invitations.filter((inv) => inv.status === 'pending');

      for (const inv of currentPending) {
        try {
          // Fetch fresh KeyPackage for the pending device. fetchUserDevices only returns
          // devices active within the last 30 days; fall back to fetchDeviceKeyPackage for
          // older ones. null from the fallback means the device was deregistered.
          // Best-effort (`.catch(() => [])`) : un echec reseau ici ne doit pas court-circuiter
          // le fallback fetchDeviceKeyPackage ci-dessous (liste vide => on tente le fallback).
          const devices = await mlsService.fetchUserDevices(inv.userId).catch(() => []);
          let targetDevice = devices.find((d) => d.deviceId === inv.deviceId);
          if (!targetDevice) {
            const fallback = await mlsService
              .fetchDeviceKeyPackage(inv.userId, inv.deviceId)
              .catch(() => null);
            if (!fallback) {
              log(`[PENDING] Device ${inv.deviceId} introuvable (désenregistré) → nettoyage`);
              mlsService.deleteDeviceMembership(inv.userId, inv.deviceId, groupId).catch(() => {});
              continue;
            }
            targetDevice = fallback;
            log(`[PENDING] KeyPackage récupéré via fallback pour ${inv.deviceId} (> 30 jours)`);
          }

          // Idempotence : si le leaf du device est déjà dans l'arbre MLS, l'invitation est
          // remplie - on SKIP, quel que soit le statut serveur. On ne kicke JAMAIS ici.
          //
          // Un device hors-ligne rejoindra via son Welcome déjà en file quand il reviendra ;
          // un device qui a réellement perdu son état émettra lui-même un welcome_request
          // (chemin signal-driven, avec limiteur anti-livelock dans handleWelcomeRequest).
          // Kicker proactivement un leaf valide est purement nuisible : ça inflate l'epoch à
          // chaque sync, invalide le Welcome en file (le device reçoit alors un Welcome périmé
          // → re-welcome_request → churn) et renvoie le bundle historique pour rien. C'est la
          // cause des cycles kick+re-add répétés à chaque reconnexion sur les devices pairs
          // hors-ligne (statut figé à 'pending' car ils ne confirment jamais 'active').
          try {
            const members = await mlsService.getGroupMembers(groupId);
            if (members.some((m) => m.deviceId === inv.deviceId)) {
              log(
                `[PENDING] ${inv.deviceId} déjà dans l'arbre de ${groupId} - skip (rejoint via Welcome en file)`
              );
              continue;
            }
          } catch {
            /* proceed with add attempt */
          }

          // Add the member to the MLS group
          const result = await mlsService.addMember(groupId, targetDevice.keyPackage);

          // Register member on server (upsert GroupMember row) (not strictly necessary to add before Welcome, but keeps server state more up-to-date in case of failure during the MLS flow)
          await mlsService.registerMember(groupId, inv.userId);

          // Send Welcome
          if (result.welcome) {
            await mlsService.sendWelcome(
              result.welcome,
              inv.userId,
              groupId,
              inv.deviceId,
              result.ratchetTree
            );
            totalWelcomes++;
            log(`[PENDING] Welcome → ${inv.deviceId} (user: ${inv.userId}) pour ${groupId}`);
          }

          // Save MLS state before commit (crash-safety)
          await persistMlsStateAfterMutation(mlsService, userId, pin, log);

          // Send commit, excluding the inviter (self) and the newly-welcomed device
          let commitError: unknown = null;
          if (result.commit) {
            try {
              await mlsService.sendCommit(result.commit, groupId, [
                `${inv.userId}:${inv.deviceId}`,
              ]);
            } catch (e) {
              commitError = e;
            }
          }

          // Le history bundle = MESSAGES APPLICATIFS (pas un commit, ne passe pas par
          // validateCommit). Le nouveau membre a deja rejoint via le Welcome (meme epoch que
          // nous), donc on lui envoie l'historique meme si le broadcast du commit a echoue -
          // sinon un commit rejete (course concurrente ou compteur serveur en retard) le
          // priverait silencieusement de tout l'historique. [[C8]]
          const bundlePromise = sendFullHistoryBundle(groupId, {
            storage,
            pin,
            mlsService,
            log,
          }).catch((e) =>
            log(`[HISTORY_BUNDLE] Erreur envoi historique à ${inv.userId}: ${String(e)}`)
          );

          if (commitError) {
            // La recovery (catch) va forgetGroup : on attend la fin de l'envoi de l'historique
            // pour ne pas le couper, puis on remonte l'erreur de commit.
            await bundlePromise;
            throw commitError;
          }
        } catch (e) {
          const errStr = String(e);

          // NOTRE commit (addMember mergé localement) a été rejeté pour epoch_mismatch : on a
          // perdu une course concurrente et on est sur une branche divergente. Tous nos commits
          // suivants seront rejetés et le commit gagnant sera dropé comme same-epoch bénin -> on
          // ne rattrape jamais seul. On oublie l'état périmé (en rejetant les Welcomes < epoch
          // serveur) et on redemande un Welcome, puis on abandonne CE groupe pour ce cycle. On
          // escalade dès un écart de 1 (`isSenderForkError`), pas seulement >= 2. [[C7]]
          const forked = parseForkedEpoch(e);
          if (isSenderForkError(e)) {
            log(`[PENDING] ${groupId.slice(0, 8)}… forké (commit rejeté) - recovery + abandon`);
            if (recoverForkedGroup)
              await recoverForkedGroup(groupId, forked?.serverEpoch).catch(() => {});
            break;
          }

          // Device déjà membre de l'arbre : l'invitation est remplie (le device rejoindra via
          // son Welcome en file). On ne kicke pas - skip silencieux pour stopper le re-essai.
          if (errStr.includes('ALREADY_MEMBER')) {
            log(
              `[PENDING] ${inv.deviceId} déjà membre de ${groupId.slice(0, 8)}… - invitation remplie, skip`
            );
            continue;
          }

          if (errStr.includes('DuplicateSignatur')) {
            log(`[PENDING] ${inv.deviceId} déjà dans l'arbre MLS de ${groupId}`);
            // Le kick déclenché ici génère lui-même un commit : s'il est rejeté pour fork,
            // handleDuplicateLeafError remonte l'erreur → on bascule en recovery.
            try {
              await handleDuplicateLeafError({
                mlsService,
                groupId,
                targetUserId: inv.userId,
                targetDeviceId: inv.deviceId,
                userId,
                pin,
                log,
              });
            } catch (kickErr) {
              if (isSenderForkError(kickErr)) {
                log(
                  `[PENDING] ${groupId.slice(0, 8)}… forké (kick rejeté) - recovery + abandon du groupe`
                );
                if (recoverForkedGroup)
                  await recoverForkedGroup(groupId, parseForkedEpoch(kickErr)?.serverEpoch).catch(
                    () => {}
                  );
                break;
              }
              log(
                `[PENDING] Erreur kick ${inv.deviceId} dans ${groupId}: ${String(kickErr).slice(0, 100)}`
              );
            }
          } else if (errStr.includes('WrongEpoch') || errStr.includes('epoch_mismatch')) {
            // Course concurrente transitoire (écart 1) : un autre device a committé en même
            // temps. On vérifie si l'invitation est déjà remplie, sinon on laisse le prochain
            // cycle réessayer (le commit manquant arrive via la file et on rattrape seul).
            log(`[PENDING] WrongEpoch pour ${inv.deviceId} dans ${groupId} - vérification…`);
            try {
              const memberships = await mlsService.getDeviceMemberships(inv.userId, inv.deviceId);
              const m = memberships.find((x) => x.groupId === groupId);
              if (m?.status === 'active') {
                log(`[PENDING] ${inv.deviceId} déjà actif - skip`);
                continue;
              }
            } catch {
              /* ignore */
            }
            log(`[PENDING] Erreur non-récupérable pour ${inv.deviceId}: ${errStr.slice(0, 100)}`);
          } else {
            log(`[PENDING] Erreur ajout ${inv.deviceId} à ${groupId}: ${errStr.slice(0, 100)}`);
          }
        }
      }
    } finally {
      await mlsService.releaseAddLock(groupId).catch(() => {});
    }
  }

  if (totalWelcomes > 0) {
    log(`[PENDING] ${totalWelcomes} Welcome(s) envoyé(s).`);
  }
}

/**
 * Force re-processing of pending device invitations.
 * Clears any stale local MLS autosave so the next reload starts fresh.
 */
export function forceSyncReset(_userId: string, log: (msg: string) => void) {
  log(`[SYNC] Reset forcé. Rechargez la page pour relancer le traitement des invitations.`);
}

/**
 * Découverte des groupes manquants.
 *
 * Crée des placeholders locaux pour les groupes serveur absents du client
 * (Welcome perdu, nouveau device, etc.) et supprime immédiatement les groupes
 * locaux absents du serveur (si la liste serveur a bien été récupérée).
 *
 * IMPORTANT : l'identifiant unique est le couple (userId, deviceId).
 * Un même userId peut avoir plusieurs devices - ne jamais utiliser userId
 * seul pour identifier un participant ou un leaf node.
 */
export async function discoverMissingGroups(params: {
  mlsService: IMlsService;
  userId: string;
  pin: string;
  conversations: Map<string, Conversation>;
  saveConversation?: (key: string) => Promise<void>;
  deleteConversation?: (key: string) => Promise<void>;
  log: (msg: string) => void;
  /** Optionnel : accès IndexedDB pour vérifier que les messages ont été migrés avant purge. */
  storage?: IStorage | null;
}) {
  const {
    mlsService,
    userId,
    pin,
    conversations,
    saveConversation,
    deleteConversation,
    log,
    storage,
  } = params;

  // ── Phase 1: Create placeholders for server groups not present locally ────

  let serverGroups: {
    groupId: string;
    name: string;
    isGroup: boolean;
    imageMediaId?: string | null;
    successorId?: string | null;
    deletedAt?: string | null;
  }[] = [];
  let serverFetchSucceeded = false;
  try {
    serverGroups = await mlsService.getUserGroups(userId);
    serverFetchSucceeded = true;
  } catch {
    // Continue to Phase 2 even if server fetch fails - there may be pending placeholders
  }

  // Some backends can transiently return duplicates; keep first occurrence by groupId.
  const uniqueServerGroups = Array.from(new Map(serverGroups.map((g) => [g.groupId, g])).values());

  // Active groups only: exclude soft-deleted (replaced by a successor).
  // Soft-deleted groups still exist on the server for recovery routing but should not
  // be created as local placeholders - checkGroupSuccessors handles the migration.
  const activeServerGroups = uniqueServerGroups.filter((g) => !g.deletedAt);

  // ── Orphan cleanup (server membership = source of truth) ─────────────────
  // Phase 1 - MLS WASM: drop OpenMLS trees for groupIds absent from the server.
  // Phase 2 - UI/IndexedDB: drop conversation rows (may exist without WASM state).
  // Only when getUserGroups succeeded (never purge on transient network errors).
  if (serverFetchSucceeded) {
    const serverGroupIds = new Set(uniqueServerGroups.map((g) => g.groupId));
    const knownSuccessorIds = collectKnownSuccessorIds(uniqueServerGroups);
    // Groupes que CET utilisateur a dismisses (suppression/quitter manuel sur un appareil) : ils
    // doivent etre purges sur TOUS ses appareils (regles 3 & 5), pas affiches avec la banniere.
    // Best-effort (`[]` sur echec -> on ne purge jamais sur un doute).
    const dismissedGroupIds = new Set(await mlsService.getDismissedGroups().catch(() => []));
    let mlsMutated = false;

    for (const groupId of mlsService.getLocalGroups()) {
      if (isChannelConversationId(groupId)) continue;
      const serverEntry = uniqueServerGroups.find((g) => g.groupId === groupId);
      if (
        serverEntry?.successorId &&
        mlsService.getLocalGroups().includes(serverEntry.successorId)
      ) {
        if (forgetMlsGroupIfPresent(mlsService, groupId, log)) mlsMutated = true;
        continue;
      }
      if (!serverGroupIds.has(groupId)) {
        if (forgetMlsGroupIfPresent(mlsService, groupId, log)) mlsMutated = true;
      }
    }
    if (mlsMutated) {
      await persistMlsStateAfterMutation(mlsService, userId, pin, log);
    }

    for (const [key, convo] of conversations.entries()) {
      if (isChannelConversationId(key)) continue;

      // Dismissé par l'utilisateur (suppression/quitter manuel sur un autre appareil). Deux cas :
      //  - on n'est plus membre actif -> on PURGE (regles 3 & 5), sans bannière. Priorite max.
      //  - on est de nouveau membre actif (RE-INVITE depuis) -> le dismiss est perime : on le leve
      //    cote serveur et on garde la conversation (regle re-add). On ne purge surtout pas, sinon
      //    on supprimerait un groupe qu'on vient de rejoindre.
      if (dismissedGroupIds.has(convo.id)) {
        if (!serverGroupIds.has(convo.id)) {
          log(
            `[DISCOVERY] Groupe UI "${convo.name || convo.id}" dismissé par l'utilisateur - retrait`
          );
          await purgeLocalConversationRecord({
            conversations,
            contactKey: key,
            groupId: convo.id,
            deleteConversation,
            log,
          });
          continue;
        }
        log(
          `[DISCOVERY] "${convo.name || convo.id}" dismissé mais on en est de nouveau membre - dismiss levé`
        );
        void mlsService.undismissGroup(convo.id).catch(() => {});
        // On laisse le traitement normal continuer (groupe actif).
      }

      const { terminalId, hasChain } = await resolveTerminalGroup(mlsService, convo.id).catch(
        () => ({ terminalId: convo.id, hasChain: false })
      );
      if (hasChain && terminalId !== convo.id && conversations.has(terminalId)) {
        // Sécurité migration : ne pas supprimer la source si ses messages ne sont pas encore
        // dans le groupe terminal (cas d'un reboot/migration interrompu).
        if (storage) {
          const pendingMsgs = await storage.getMessages(convo.id, pin).catch(() => []);
          if (pendingMsgs.length > 0) {
            log(
              `[DISCOVERY] ${convo.id.slice(0, 8)}… conservé - ${pendingMsgs.length} msg(s) non encore migrés vers ${terminalId.slice(0, 8)}…`
            );
            continue;
          }
        }
        log(
          `[DISCOVERY] Groupe UI "${convo.name || convo.id}" → terminal ${terminalId.slice(0, 8)}… - retrait`
        );
        await purgeLocalConversationRecord({
          conversations,
          contactKey: key,
          groupId: convo.id,
          deleteConversation,
          log,
        });
        continue;
      }

      const serverEntry = uniqueServerGroups.find((g) => g.groupId === convo.id);
      if (serverEntry?.successorId && conversations.has(serverEntry.successorId)) {
        // Sécurité migration : ne pas supprimer la source si ses messages ne sont pas encore
        // dans le groupe successeur (cas d'un reboot/migration interrompu).
        if (storage) {
          const pendingMsgs = await storage.getMessages(convo.id, pin).catch(() => []);
          if (pendingMsgs.length > 0) {
            log(
              `[DISCOVERY] ${convo.id.slice(0, 8)}… conservé - ${pendingMsgs.length} msg(s) non encore migrés vers ${serverEntry.successorId.slice(0, 8)}…`
            );
            continue;
          }
        }
        log(
          `[DISCOVERY] Groupe UI "${convo.name || convo.id}" migré vers ${serverEntry.successorId} - retrait`
        );
        await purgeLocalConversationRecord({
          conversations,
          contactKey: key,
          groupId: convo.id,
          deleteConversation,
          log,
        });
        continue;
      }

      if (!serverGroupIds.has(convo.id)) {
        // Décision de sort centralisée dans `decideAbsentGroupFate` (source unique partagée avec
        // les autres réconciliateurs). On ne sollicite le serveur que pour les cas réellement
        // indécis : un successeur tombstone connu ou une conv déjà `deletedRemotely` court-circuitent
        // sans appel réseau (la migration / la suppression manuelle s'en chargent).
        const isKnownSuccessor = knownSuccessorIds.has(convo.id);
        let serverStatus: GroupServerStatus = { kind: 'unknown' };
        let isStillUserMember: boolean | null = null;
        if (!isKnownSuccessor && convo.lifecycle !== 'removed') {
          serverStatus = classifyServerStatus(await mlsService.getGroupServerStatus(convo.id));
          // Anti-race : ne revalider notre membership réelle que sur un groupe VIVANT absent de
          // notre snapshot getUserGroups (qui peut être périmé sur un groupe juste créé/rejoint).
          if (serverStatus.kind === 'active') {
            const userMembers = await mlsService.getGroupUserMembers(convo.id).catch(() => null);
            isStillUserMember =
              userMembers === null ? null : userMembers.some((m) => m.userId === userId);
          }
        }

        const fate = decideAbsentGroupFate({
          isKnownSuccessor,
          lifecycle: convo.lifecycle,
          serverStatus,
          isStillUserMember,
        });
        const label = convo.name || convo.id;

        if (fate.action === 'purge') {
          log(`[DISCOVERY] Groupe UI "${label}" - ${fate.reason} - retrait`);
          await purgeLocalConversationRecord({
            conversations,
            contactKey: key,
            groupId: convo.id,
            deleteConversation,
            log,
          });
          continue;
        }
        if (fate.action === 'markRemoved') {
          conversations.set(key, { ...convo, lifecycle: 'removed' });
          await saveConversation?.(key).catch(() => {});
          log(`[DISCOVERY] Groupe UI "${label}" ${fate.reason} - marqué removed`);
          continue;
        }
        // keep
        log(`[DISCOVERY] Groupe UI "${label}" conservé - ${fate.reason}`);
        continue;
      }
    }
  }

  // Include both ready and placeholder conversations to avoid recreating
  // the same pending entry on each login.
  // Only create placeholders for active groups - soft-deleted ones are handled by checkGroupSuccessors.
  const localGroupIds = new Set([...conversations.values()].map((c) => c.id));
  const missing = activeServerGroups.filter((g) => !localGroupIds.has(g.groupId));

  if (missing.length > 0) {
    log(
      `[DISCOVERY] ${missing.length} groupe(s) serveur absent(s) localement: ${missing.map((g) => g.name || g.groupId).join(', ')}`
    );
  }

  for (const g of missing) {
    if (conversations.has(g.groupId)) continue;

    const directPeer = !g.isGroup ? parseDirectPeerFromName(g.name || '', userId) : null;
    const displayName = directPeer || g.name || g.groupId;

    // Dédoublon local : si une conv directe avec ce même pair existe déjà
    // sous un groupId différent (doublon côté serveur), on ne crée pas un
    // second placeholder - on met juste à jour la clé si nécessaire.
    if (directPeer) {
      const alreadyLoaded = [...conversations.values()].find(
        (c) =>
          (c.conversationType ?? 'group') === 'direct' &&
          (c.directPeerId ?? c.contactName).toLowerCase() === directPeer
      );
      if (alreadyLoaded) {
        log(`[DISCOVERY] Doublon ignoré pour "${directPeer}" (existant: ${alreadyLoaded.id})`);
        continue;
      }
    }

    const key = g.groupId; // map key = groupId
    conversations.set(key, {
      id: g.groupId,
      contactName: displayName,
      name: displayName,
      messages: [],
      lifecycle: 'pending', // placeholder until the Welcome is processed
      mlsStateHex: null,
      conversationType: g.isGroup ? 'group' : 'direct',
      imageMediaId: g.imageMediaId ?? null,
      ...(directPeer ? { directPeerId: directPeer } : {}),
    });
    if (saveConversation) {
      try {
        await saveConversation(key);
      } catch (e) {
        log(
          `[WARN] Echec persistance placeholder ${g.groupId}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    log(`[DISCOVERY] Placeholder "${displayName}" créé.`);
  }

  // ── Seed group avatars from the server (source of truth) ─────────────────
  // imageMediaId is not persisted in the local ConversationMeta; it is re-seeded
  // from getUserGroups on every discovery so a freshly-loaded or new device shows
  // the current group photo. Live changes still arrive via the MLS system message.
  for (const g of activeServerGroups) {
    if (!g.isGroup) continue;
    const convo = conversations.get(g.groupId);
    const nextImage = g.imageMediaId ?? null;
    if (convo && (convo.imageMediaId ?? null) !== nextImage) {
      conversations.set(g.groupId, { ...convo, imageMediaId: nextImage });
    }
  }
}

/** Exports the user's full backup (conversations + messages + MLS state) as a `.canari` file. In Tauri opens a folder picker; in the browser triggers an anchor download. */
export async function exportUserBackup(params: {
  storage: IStorage;
  userId: string;
  pin: string;
  myDeviceId: string;
  log: (msg: string) => void;
}) {
  const { storage, userId, pin, myDeviceId, log } = params;
  const mlsStateHex = await exportMlsStateAsHex(userId);
  const blob = await exportBackup(storage, userId, pin, myDeviceId, mlsStateHex);
  const date = new Date().toISOString().split('T')[0];
  const filename = `canari-backup-${userId}-${date}.canari`;

  if (isTauriRuntime()) {
    // In Tauri (desktop/mobile) blob URLs and anchor downloads do not work.
    // Delegate file writing to the Rust side which saves to the Downloads
    // folder (desktop) or app data dir (mobile).

    const dialog = await import('@tauri-apps/plugin-dialog');
    const fs = await import('@tauri-apps/plugin-fs');
    // Dynamic import: avoids bundling @tauri-apps/api/path in the Web build.
    const { downloadDir } = await import('@tauri-apps/api/path');

    const path = await dialog.open({
      multiple: false,
      directory: true,
      defaultPath: await downloadDir(),
    });
    if (path === null) {
      console.info('directory selection cancelled');
      return;
    }
    const file = await fs.create(`${path}/${filename}`);
    await file.write(new Uint8Array(blob.buffer as ArrayBuffer));
    await file.close();
    log(`[OK] Sauvegarde exportée : ${filename}`);
  } else {
    const url = URL.createObjectURL(
      new Blob([blob.buffer as ArrayBuffer], { type: 'application/octet-stream' })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    log(`[OK] Sauvegarde exportée : ${filename}`);
  }
}

/** Imports a `.canari` backup file: decrypts conversations/messages, restores the MLS state if this is the same device, then reloads the conversation list. */
export async function importUserBackup(params: {
  file: File;
  pin: string;
  storage: IStorage;
  myDeviceId: string;
  userId: string;
  log: (msg: string) => void;
  reloadConversations: () => Promise<void>;
  clearConversations: () => void;
}) {
  const { file, pin, storage, myDeviceId, userId, log, reloadConversations, clearConversations } =
    params;

  const arrayBuffer = await file.arrayBuffer();
  const { data: backup, isSameDevice } = await importBackup(
    new Uint8Array(arrayBuffer),
    pin,
    storage,
    myDeviceId
  );

  if (isSameDevice) {
    const existingMlsState = await loadMlsState(userId);
    if (backup.mlsState && !existingMlsState) {
      await saveMlsState(userId, fromHex(backup.mlsState));
      log('État MLS restauré (même appareil).');
    } else if (existingMlsState) {
      log('État MLS local conservé (appareil déjà actif).');
    }
  } else {
    log(
      '[ATTENTION] Nouvel appareil detecte. Les conversations sont importees en lecture seule. ' +
        "Reconnectez l'appareil exportateur pour declencher l'invitation automatique aux groupes."
    );
  }

  clearConversations();
  await reloadConversations();

  log(
    `[OK] Sauvegarde importee : ${backup.conversations.length} conversation(s), ` +
      `${backup.messages.length} message(s).`
  );
}

/** Dev helper: generates a new MLS KeyPackage for this device and returns it as a hex string. */
export async function generateDevKeyPackage(params: { mlsService: IMlsService; pin: string }) {
  const { mlsService, pin } = params;
  const bytes = await mlsService.generateKeyPackage(pin);
  return toHex(bytes);
}

/** Dev helper: adds a member to a group using a hex-encoded KeyPackage, returning the commit and welcome as hex strings. */
export async function addDevMember(params: {
  mlsService: IMlsService;
  groupId: string;
  incomingBytesHex: string;
}) {
  const { mlsService, groupId, incomingBytesHex } = params;
  const result = await mlsService.addMember(groupId, fromHex(incomingBytesHex));
  return {
    commitHex: toHex(result.commit),
    welcomeHex: result.welcome ? toHex(result.welcome) : '',
  };
}

/** Dev helper: processes an MLS Welcome message from a hex-encoded byte string. */
export async function processDevWelcome(params: {
  mlsService: IMlsService;
  incomingBytesHex: string;
}) {
  const { mlsService, incomingBytesHex } = params;
  await mlsService.processWelcome(fromHex(incomingBytesHex));
}

// In-process guard: prevents the same tab from handling two welcome_requests
// for the same group concurrently (e.g. rapid retries arriving before the
// first one finishes).  Cross-device races are handled by acquireAddLock below.
const welcomeRequestInProgress = new Set<string>();

/** Ré-ajouts répétés par clé `${groupId}:${requesterDeviceId}` dans la fenêtre glissante. */
const reAddAttempts = new Map<string, { count: number; first: number }>();

/** Au-delà de ce nombre de ré-ajouts d'un même device dans la fenêtre, on suspend. */
const MAX_READD_ATTEMPTS = 3;

/** Fenêtre glissante du garde-fou anti-livelock de ré-ajout. */
const READD_WINDOW_MS = 3 * 60_000;

/** Horodatage du dernier Welcome envoyé par clé `${groupId}:${requesterDeviceId}`. */
const lastWelcomeSentAt = new Map<string, number>();

/**
 * Délai pendant lequel un device fraîchement invité est présumé " en cours de jointure ".
 * Tant qu'il court, on ignore ses nouvelles welcome_request : son leaf est neuf, pas stale,
 * et le re-kicker l'évincerait (l'invité tomberait en UseAfterEviction à l'envoi). Doit
 * couvrir le déchiffrement du Welcome + l'ingestion du bundle historique (plusieurs secondes).
 */
const WELCOME_COOLDOWN_MS = 30_000;

/**
 * Traite un welcome_request reçu d'un device qui veut rejoindre un groupe.
 *
 * Cas nominal : addMember → sendWelcome → sendCommit.
 *
 * Cas "leaf déjà présent" : si le device était précédemment dans le groupe
 * (stale, crash, etc.), son leaf node est encore dans l'arbre MLS mais son
 * état local est perdu. Dans ce cas :
 *   1. removeMemberDevice (kick le leaf stale)
 *   2. kickStaleDevice (reset la membership serveur à pending)
 *   3. addMember avec un KeyPackage frais → sendWelcome → sendCommit
 *
 * IMPORTANT : l'identifiant unique est (userId, deviceId), pas userId seul.
 *
 * Security: refuses to re-add a requester absent from dm_group_members (a removed user).
 * The gateway authenticates the sender but does not check their membership before relaying.
 */
export async function handleWelcomeRequest(params: {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  pin: string;
  conversations: Map<string, Conversation>;
  log: (msg: string) => void;
  requesterUserId: string;
  requesterDeviceId: string;
  groupId: string;
  /** Appelé quand le groupe terminal existe mais n'est pas encore prêt (Welcome en transit). */
  onNotReady?: (terminalGroupId: string) => void;
  /**
   * Recovery d'un groupe dont NOTRE état local est forké en retard (commit rejeté
   * epoch_mismatch lors de l'ajout). Effectue forget + welcome_request.
   * `minEpoch` (epoch serveur connue) rejette les Welcomes stale d'une branche divergée.
   */
  recoverForkedGroup?: (groupId: string, minEpoch?: number) => Promise<void>;
}) {
  const {
    mlsService,
    storage,
    userId,
    pin,
    conversations,
    log,
    requesterUserId,
    requesterDeviceId,
    groupId: requestedGroupId,
    onNotReady,
    recoverForkedGroup,
  } = params;

  // Garde anti-self : le gateway diffuse les welcome_request à TOUS les devices du
  // user, émetteur compris. Un device ne doit jamais traiter sa propre demande : il se
  // retrouverait lui-même dans l'arbre MLS et kickerait son propre leaf (auto-éviction),
  // se retirant du groupe qu'il vient de créer et relançant la cascade de successeurs.
  if (requesterUserId === userId && requesterDeviceId === mlsService.getDeviceId()) {
    log(`[WELCOME_REQ] Demande émise par soi-même (${requesterDeviceId.slice(0, 12)}…) - ignorée`);
    return;
  }

  // Résoudre le groupe terminal dans la lignée de successeurs (max 10 hops).
  const {
    terminalId,
    groupMeta: terminalMeta,
    hasChain,
  } = await resolveTerminalGroup(mlsService, requestedGroupId);

  // Groupe introuvable sur le serveur.
  if (!terminalMeta) {
    log(`[WELCOME_REQ] Groupe ${requestedGroupId.slice(0, 8)}… introuvable - refus`);
    return;
  }

  // Toute la lignée est supprimée - refuser d'inviter dans un groupe mort.
  if (terminalMeta.deletedAt) {
    log(`[WELCOME_REQ] Lignée de ${requestedGroupId.slice(0, 8)}… supprimée - refus`);
    return;
  }

  if (hasChain) {
    log(`[WELCOME_REQ] ${requestedGroupId.slice(0, 8)}… → terminal ${terminalId.slice(0, 8)}…`);
  }

  // groupId pointe désormais vers le terminal de la lignée.
  const groupId = terminalId;

  // ── Membership guard (security) ─────────────────────────────────────────────
  // The gateway authenticates the sender (no spoofing) but relays the request without checking
  // membership; we must therefore refuse here to re-add a REMOVED user. The source of truth is
  // dm_group_members (user-level): a removed user no longer has a row, whereas a legitimate
  // invited/pending user has one BEFORE emitting any welcome_request (addGroupMember /
  // acceptGroupInvite create it first). We cannot gate on group:members / the MLS tree: the very
  // purpose of a welcome_request is to serve someone absent from routing (lost WASM state).
  // Fail-closed: if the list is unavailable (network), refuse - the requester retries (60s cadence)
  // and another peer can honor it. Never re-add on doubt.
  const userMembers = await mlsService.getGroupUserMembers(groupId).catch(() => null);
  if (userMembers === null) {
    log(
      `[WELCOME_REQ] Members of ${groupId.slice(0, 8)}… unavailable - refused (requester will retry)`
    );
    return;
  }
  if (!userMembers.some((m) => m.userId === requesterUserId)) {
    log(
      `[WELCOME_REQ] ${requesterUserId} not a member of ${groupId.slice(0, 8)}… (removed) - re-add refused`
    );
    return;
  }

  // Défense en profondeur : vérifier qu'on a une conversation prête pour ce groupe terminal.
  // Si ce device n'est pas encore dans le groupe terminal (Welcome en transit ou sync initial
  // pas terminé), signaler via onNotReady pour que l'appelant diffère et réessaie.
  if (conversations.get(groupId)?.lifecycle !== 'active') {
    log(`[WELCOME_REQ] Pas de conversation prête pour ${groupId.slice(0, 8)}… - report`);
    onNotReady?.(groupId);
    return;
  }

  // Guard in-process : empêche deux traitements simultanés du même groupe
  // dans le même onglet (les retries rapides arrivent avant la fin du premier)
  if (welcomeRequestInProgress.has(groupId)) {
    log(`[WELCOME_REQ] Déjà en cours pour ${groupId} - skip`);
    return;
  }
  welcomeRequestInProgress.add(groupId);

  // Acquérir le verrou distribué pour éviter les races avec
  // processPendingInvitations sur un autre device du même groupe (TTL par defaut, cf. H1)
  const lockAcquired = await mlsService.acquireAddLock(groupId).catch(() => false);
  if (!lockAcquired) {
    log(`[WELCOME_REQ] Verrou occupé pour ${groupId} - autre device en cours, skip`);
    welcomeRequestInProgress.delete(groupId);
    return;
  }

  try {
    const attemptKey = `${groupId}:${requesterDeviceId}`;
    const now = Date.now();

    // Cooldown post-Welcome : si on a envoyé un Welcome à ce device récemment, il est
    // presque sûrement encore en train de le traiter (déchiffrement + bundle historique
    // prennent plusieurs secondes). Le re-kicker maintenant évincerait un leaf fraîchement
    // ajouté → l'invité tombe en UseAfterEviction à l'envoi. On le laisse finir de rejoindre.
    const lastWelcome = lastWelcomeSentAt.get(attemptKey);
    if (lastWelcome && now - lastWelcome < WELCOME_COOLDOWN_MS) {
      log(
        `[WELCOME_REQ] ${requesterDeviceId.slice(0, 12)}… Welcome envoyé il y a ${Math.round((now - lastWelcome) / 1000)}s - jointure en cours, skip`
      );
      return;
    }

    // Garde-fou anti-livelock : limite les ré-ajouts répétés du même device dans une
    // fenêtre glissante. Si l'invité reboucle (ses KeyPackages publiés sont orphelins
    // de leur clé privée → NoMatchingKeyPackage côté invité), le re-add est inutile et
    // resaturerait le serveur (Welcome + bundle historique à chaque tour). La correction
    // est côté invité (republication) ; ici on cesse simplement de re-boucler.
    const prev = reAddAttempts.get(attemptKey);
    const attempt = prev && now - prev.first < READD_WINDOW_MS ? prev : { count: 0, first: now };
    attempt.count += 1;
    reAddAttempts.set(attemptKey, attempt);
    if (attempt.count > MAX_READD_ATTEMPTS) {
      log(
        `[WELCOME_REQ] ${requesterDeviceId.slice(0, 12)}… ré-ajouté ${attempt.count - 1}× en vain sur ${groupId.slice(0, 8)}… - re-add suspendu (cause côté invité)`
      );
      return;
    }

    // Récupérer le KeyPackage frais du device demandeur.
    // Si absent : le device n'a pas encore publié ses KP → on ne peut pas l'inviter.
    // La causalité est assurée en amont : syncConnectionAfterWsOpen n'envoie pas de
    // welcome_request tant que generateKeyPackage n'a pas réussi.
    // Best-effort : un echec reseau ne doit pas court-circuiter le fallback fetchDeviceKeyPackage.
    const devices = await mlsService.fetchUserDevices(requesterUserId).catch(() => []);
    let targetDevice = devices.find((d) => d.deviceId === requesterDeviceId);
    if (!targetDevice) {
      // fetchUserDevices applique un cutoff de 30 jours : le device demandeur peut en être
      // absent (ancien device qui se reconnecte). On retente via fetchDeviceKeyPackage, qui
      // n'a pas de cutoff - même fallback que processPendingInvitations. Sans ça, un device
      // valide mais hors fenêtre reste bloqué (abandon silencieux, aucun re-add possible).
      const fallback = await mlsService
        .fetchDeviceKeyPackage(requesterUserId, requesterDeviceId)
        .catch(() => null);
      if (!fallback) {
        log(`[WELCOME_REQ] KeyPackage introuvable pour ${requesterDeviceId} - abandon`);
        return;
      }
      targetDevice = fallback;
      log(`[WELCOME_REQ] KeyPackage récupéré via fallback pour ${requesterDeviceId} (> 30 jours)`);
    }

    // ── Vérifier si le leaf du device est déjà dans l'arbre MLS ────────
    // Ne pas tester status='active' ici : sendWelcome marque le device actif de façon
    // optimiste avant que le téléphone traite le Welcome. Si le device perd son état
    // WASM (redémarrage, fresh-install, NoMatchingKeyPackage), il renvoie une
    // welcome_request alors qu'il est déjà marqué 'active' côté serveur.
    // → toujours kicker + ré-ajouter quand le leaf est présent dans l'arbre.
    try {
      const currentMembers = await mlsService.getGroupMembers(groupId);
      if (currentMembers.some((m) => m.deviceId === requesterDeviceId)) {
        log(
          `[WELCOME_REQ] ${requesterDeviceId.slice(0, 12)}… leaf dans l'arbre MLS - kick + ré-ajout`
        );
        await kickStaleLeaf(groupId, requesterUserId, requesterDeviceId, mlsService, log);

        // Sauvegarder l'état MLS après le remove commit
        await persistMlsStateAfterMutation(mlsService, userId, pin, log);

        // Re-fetch le KeyPackage (peut avoir changé après le kick)
        // Best-effort : liste vide sur echec reseau => freshDevice introuvable => skip propre.
        const freshDevices = await mlsService.fetchUserDevices(requesterUserId).catch(() => []);
        const freshDevice = freshDevices.find((d) => d.deviceId === requesterDeviceId);
        if (!freshDevice) {
          log(`[WELCOME_REQ] KeyPackage introuvable après kick pour ${requesterDeviceId} - skip`);
          return;
        }
        // Mettre à jour la référence pour l'ajout ci-dessous
        targetDevice.keyPackage = freshDevice.keyPackage;
      }
    } catch {
      // En cas d'erreur sur la vérification, on tente quand même l'ajout
    }

    // ── Ajouter le device au groupe MLS ────────────────────────────────
    const result = await mlsService.addMember(groupId, targetDevice.keyPackage);
    await mlsService.registerMember(groupId, requesterUserId);

    // Envoyer le Welcome au device demandeur
    if (result.welcome) {
      await mlsService.sendWelcome(
        result.welcome,
        requesterUserId,
        groupId,
        requesterDeviceId,
        result.ratchetTree
      );
      lastWelcomeSentAt.set(attemptKey, Date.now());
      log(`[WELCOME_REQ] Welcome → ${requesterUserId}:${requesterDeviceId} pour ${groupId}`);
    }

    // Sauvegarder l'état MLS avant le commit (crash-safety)
    await persistMlsStateAfterMutation(mlsService, userId, pin, log);

    // Broadcaster le commit en excluant l'inviteur (self) et l'invité
    let commitError: unknown = null;
    if (result.commit) {
      try {
        await mlsService.sendCommit(result.commit, groupId, [
          `${requesterUserId}:${requesterDeviceId}`,
        ]);
      } catch (e) {
        commitError = e;
      }
    }

    // Envoyer l'intégralité de l'historique au nouveau membre. C'est des MESSAGES APPLICATIFS
    // (pas un commit, ne passe pas par validateCommit) : le destinataire a deja rejoint via le
    // Welcome (meme epoch que nous), donc on lui envoie l'historique MEME SI le broadcast du
    // commit a echoue - sinon un commit rejete (course concurrente, compteur serveur en retard)
    // le priverait silencieusement de tout l'historique. Le bundle arrive apres le Welcome cote
    // destinataire (ordre garanti par MLS) et lit l'IndexedDB (y compris les messages migres
    // depuis le predecesseur via migrateConversation). [[C8]]
    const bundlePromise = sendFullHistoryBundle(groupId, { storage, pin, mlsService, log }).catch(
      (e) => log(`[HISTORY_BUNDLE] Erreur envoi historique à ${requesterUserId}: ${String(e)}`)
    );

    if (commitError) {
      // La recovery (catch) va forgetGroup : on attend la fin de l'envoi de l'historique pour ne
      // pas le couper, puis on remonte l'erreur de commit pour declencher la heal (C7).
      await bundlePromise;
      throw commitError;
    }
  } catch (e) {
    const errStr = String(e);

    // NOTRE commit (addMember mergé localement) a été rejeté pour epoch_mismatch : branche
    // divergente après une course concurrente perdue, on ne rattrape jamais seul (le commit
    // gagnant est dropé comme same-epoch bénin). On oublie l'état périmé et on redemande un
    // Welcome pour nous-mêmes. On escalade dès un écart de 1 (`isSenderForkError`). [[C7]]
    const forked = parseForkedEpoch(e);
    if (isSenderForkError(e)) {
      log(`[WELCOME_REQ] ${groupId.slice(0, 8)}… forké (commit rejeté) - recovery`);
      if (recoverForkedGroup)
        await recoverForkedGroup(groupId, forked?.serverEpoch).catch(() => {});
    } else if (errStr.includes('ALREADY_MEMBER')) {
      // Device déjà membre : la demande est satisfaite (il rejoindra via son Welcome en file).
      log(`[WELCOME_REQ] ${requesterDeviceId} déjà membre de ${groupId.slice(0, 8)}… - skip`);
    } else if (errStr.includes('DuplicateSignatur')) {
      try {
        await handleDuplicateLeafError({
          mlsService,
          groupId,
          targetUserId: requesterUserId,
          targetDeviceId: requesterDeviceId,
          userId,
          pin,
          log,
        });
      } catch (kickErr) {
        const kickForked = parseForkedEpoch(kickErr);
        if (isSenderForkError(kickErr)) {
          log(`[WELCOME_REQ] ${groupId.slice(0, 8)}… forké (kick rejeté) - recovery`);
          if (recoverForkedGroup)
            await recoverForkedGroup(groupId, kickForked?.serverEpoch).catch(() => {});
        } else {
          log(
            `[WELCOME_REQ] Erreur kick pour ${requesterDeviceId}: ${String(kickErr).slice(0, 100)}`
          );
        }
      }
    } else {
      log(`[WELCOME_REQ] Erreur pour ${requesterDeviceId}: ${errStr.slice(0, 100)}`);
    }
  } finally {
    await mlsService.releaseAddLock(groupId).catch(() => {});
    welcomeRequestInProgress.delete(groupId);
  }
}
