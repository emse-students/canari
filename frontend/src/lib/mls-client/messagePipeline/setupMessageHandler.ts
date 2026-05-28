import { saveMlsState } from '$lib/utils/hex';
import { isRawId, parseDirectPeerFromName } from '$lib/utils/chat/conversations';
import { decodeAppMessage } from '$lib/proto/codec';
import { appMsgToEnvelope, normalizeMessageId } from '$lib/utils/chat/messageUtils';
import { addMessageReaction } from '$lib/utils/chat/messageReactions';
import { recoverDeadGroup } from '$lib/utils/chat/recovery';
import { handleSystemEvent } from './systemMessageHandler';
import { handleChannelEvent } from './channelEventHandler';
import {
  installWasmDuplicateDeliveryLogInterceptor,
  resetWasmDuplicateDeliveryFlag,
  consumeWasmDuplicateDeliveryFlag,
} from '../wasmLogShim';
import type { MessageHandlerDeps } from './deps';
export type { MessageHandlerDeps } from './deps';

export function setupMessageHandler(deps: MessageHandlerDeps): void {
  const {
    mlsService,
    storage,
    userId,
    pin,
    historyBaseUrl,
    conversations,
    messageReactions,
    setSelectedContact,
    saveConversation,
    deleteConversation,
    addMessageToChat,
    batchAddMessages,
    loadHistoryForConversation,
    onCallSignal,
    onGroupPoisoned,
    log,
  } = deps;

  const { getSelectedContact } = deps;

  installWasmDuplicateDeliveryLogInterceptor();

  // Signal envoyé dans le message d'erreur par le layer Rust/WASM quand il a
  // mis un message en file SQLite (epoch gap Tauri). Centralisé ici pour ne pas
  // dupliquer la chaîne magique dans le handler.
  // TODO: remplacer par un type de retour discriminant dans processIncomingMessage
  //       une fois l'interface WASM mise à jour.
  const RUST_GAP_QUEUED_SIGNAL = 'GAP_QUEUED';

  // Compteur d'échecs MLS par conversation - détection des groupes fantômes
  const groupMlsFailures = new Map<string, number>();
  const PHANTOM_THRESHOLD = 3;

  // Compteur des retours `null` sur messages applicatifs (non-commit).
  // Si cela se produit, l'état local est probablement divergent même sans exception
  // (ex: SenderDataDecryption traité côté Rust comme message non-applicable).
  // Seuil à 1 : tout null inexpliqué déclenche immédiatement la recovery pour ne pas
  // laisser passer de messages silencieusement. Les duplicates légitimes sont filtrés
  // par consumeWasmDuplicateDeliveryFlag() avant d'atteindre ce compteur.
  const groupNullAppFailures = new Map<string, number>();
  const NULL_APP_THRESHOLD = 1;

  // Groups for which an epoch recovery has already been triggered
  // (avoids spamming reinvite_request on a burst of future-epoch messages).
  const epochRecoveryGroups = new Set<string>();

  // Buffer pour les messages (commits) qui arrivent AVANT leur Welcome.
  // Clé = groupId, Valeur = messages en attente de replay.
  const pendingGroupMessages = new Map<string, Array<{ sender: string; content: Uint8Array }>>();
  // Taille maximale du buffer par groupe avant d'écrêter les plus anciens.
  // Ne déclenche plus de Poison Pill directement - voir welcomeTimeouts pour la limite temporelle.
  const BUFFER_MAX_PER_GROUP = 20;
  // Minuteries de sécurité : si Welcome n'arrive pas dans 30s après le premier commit bufférisé,
  // le groupe est empoisonné. Annulées dès que le Welcome est traité.
  const welcomeTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  // Groupes pour lesquels un welcome_request a déjà été envoyé en session courante
  // (safety net : évite de spammer le serveur si syncConnectionAfterWsOpen n'a pas
  // couvert ce groupe, par ex. groupe absent des memberships au démarrage).
  const welcomeRequestedForUnknownGroups = new Set<string>();

  // Groupes définitivement empoisonnés (Poison Pill) : tout message futur est ACK'd
  // immédiatement sans traitement. Aucun retry, aucune récupération possible.
  const poisonedGroups = new Set<string>();

  // --- Persistence de l'état MLS -------------------------------------------
  // L'état MLS doit être sauvegardé quand il change :
  //   • Commits (transitions d'epoch) → immédiat, le groupe vient d'être muté.
  //   • Messages applicatifs → la clé ratchet expéditeur est consommée ; on
  //     persiste en différé (2 s) pour éviter Argon2 à chaque message.
  let _saveStateTimer: ReturnType<typeof setTimeout> | null = null;

  /** Persiste l'état MLS immédiatement (commits, Welcome, mutations de groupe). */
  function persistMlsStateNow(): void {
    if (_saveStateTimer !== null) {
      clearTimeout(_saveStateTimer);
      _saveStateTimer = null;
    }
    mlsService
      .saveState(pin)
      .then((b) => saveMlsState(userId, b))
      .catch(() => {});
  }

  /** Persiste l'état MLS en différé (messages applicatifs non-commit). */
  function scheduleMlsStatePersist(): void {
    if (_saveStateTimer !== null) return; // déjà planifié
    _saveStateTimer = setTimeout(() => {
      _saveStateTimer = null;
      mlsService
        .saveState(pin)
        .then((b) => saveMlsState(userId, b))
        .catch(() => {});
    }, 2_000);
  }

  // Groupes pour lesquels une récupération est déjà en cours.
  // Limite à 1 tentative par session - escalade vers Poison Pill en cas d'échec.
  const recoveryInProgress = new Set<string>();

  /**
   * Poison Pill : purge définitive d'un groupe irrécupérable.
   * 1. Bloque tout message futur (ACK immédiat).
   * 2. Vide le buffer en attente.
   * 3. Détruit l'état MLS local (mémoire + stockage, min_epoch=MAX).
   * 4. Notifie le serveur pour purger le membership et le routage Redis.
   */
  async function poisonPill(groupId: string): Promise<void> {
    if (poisonedGroups.has(groupId)) return;
    poisonedGroups.add(groupId);
    pendingGroupMessages.delete(groupId);
    recoveryInProgress.delete(groupId);
    const t = welcomeTimeouts.get(groupId);
    if (t !== undefined) {
      clearTimeout(t);
      welcomeTimeouts.delete(groupId);
    }
    mlsService.dropGroup(groupId);
    mlsService.forceLeaveGroup(groupId).catch(() => {});
    log(`[POISON_PILL] Groupe ${groupId} purgé définitivement - aucun retry`);
    console.warn(`[POISON_PILL] Group ${groupId} permanently dropped`);
    onGroupPoisoned?.(groupId);
  }

  /**
   * Déclenche la récupération d'epoch pour un groupe dont l'état MLS local est divergent
   * (commit rejeté, gap d'epoch, SenderDataDecryption, null applicatif inexpliqué…).
   *
   * Idempotent - ignoré silencieusement si une récupération est déjà en cours pour ce groupe.
   * Marque la conversation comme non prête, oublie l'état WASM, persiste, envoie reinvite_request.
   */
  async function triggerEpochRecovery(convoKey: string, targetEpoch?: number): Promise<void> {
    if (epochRecoveryGroups.has(convoKey)) return;
    epochRecoveryGroups.add(convoKey);
    const convo = conversations.get(convoKey);
    mlsService.forgetGroup(convoKey, targetEpoch);
    if (convo) {
      conversations.set(convoKey, { ...convo, isReady: false });
      if (storage) saveConversation(convoKey).catch(() => {});
    }
    persistMlsStateNow();
    await mlsService.sendReinviteRequest(convoKey);
  }

  if ('onChannelEvent' in mlsService) {
    (mlsService as any).onChannelEvent = async (event: any) => {
      await handleChannelEvent(event, { ...deps, triggerEpochRecovery });
    };
  }

  mlsService.onMessage(
    async (
      sender,
      content,
      groupId,
      isWelcome,
      ratchetTreeBytes,
      isCommit,
      deliveryMeta
    ): Promise<boolean> => {
      log(
        `Message de ${sender} (${content.length} octets) - Grp: ${groupId} (isWelcome: ${!!isWelcome}, isCommit: ${!!isCommit})`
      );
      if (isWelcome) {
        console.log(
          `[WS RCV] Welcome reçu de ${sender} pour groupe ${groupId} (${content.length}b)`
        );
      }
      const senderNorm = sender.toLowerCase();

      // Poison Pill guard : groupe définitivement purgé → ACK immédiat, aucun traitement.
      if (groupId && poisonedGroups.has(groupId)) {
        log(`[POISON_PILL] Message ignoré pour groupe empoisonné ${groupId}`);
        return true;
      }

      // Find conversation by groupId - the map is now keyed by id = groupId, so O(1) lookup.
      let convoKey: string | undefined;
      if (groupId) {
        convoKey = conversations.has(groupId) ? groupId : undefined;
      }

      // Log de la décision de routage
      if (convoKey) {
        log(`[ROUTE] groupId="${groupId ?? 'N/A'}" → convoKey="${convoKey}"`);
      } else if (groupId) {
        log(
          `[ROUTE] groupId="${groupId}" inconnu - ${conversations.size} convos locales, isWelcome=${!!isWelcome}` +
            (isWelcome ? ' → nouveau groupe' : ' → message bufferisé')
        );
      }

      // In the MLS model every message belongs to a group.
      // A message without groupId is either a legacy artefact or a server bug.
      // Attempting sender-based routing would silently process it in the wrong MLS
      // group → decryption error → message blocks the queue forever (return false).
      // Discard immediately with an explicit log instead.
      if (!convoKey && !groupId) {
        log(`[ROUTE] Message de ${senderNorm} sans groupId - discard (hors modèle MLS)`);
        console.warn(`[MLS] Received message from ${senderNorm} with no groupId - discarded`);
        return true;
      }

      // Welcome pour un groupe connu.
      //
      // Deux sous-cas :
      //   A) group_reset reçu avant ce Welcome (isReady=false, groupId absent du WASM)
      //      → processWelcome() instancie normalement le nouvel arbre.
      //   B) Re-bootstrap sans group_reset reçu (isReady=true, groupe en mémoire WASM)
      //      → Le WASM détecte l'epoch 0 et remplace l'état silencieusement.
      //
      // Dans les deux cas on met à jour le statut d'invitation côté serveur
      // (registerMember + welcome_received) pour que le routing redis soit correct.
      if (convoKey && isWelcome) {
        const convo = conversations.get(convoKey)!;
        const wasReady = convo.isReady;
        log(
          `[WELCOME] Welcome pour groupe connu "${convoKey}" (groupId=${groupId}) wasReady=${wasReady}`
        );
        try {
          const joinedGroupId = await mlsService.processWelcome(content, ratchetTreeBytes);
          const stBytes = await mlsService.saveState(pin);
          await saveMlsState(userId, stBytes);

          // registerMember et welcome_received sont idempotents côté serveur.
          // On les appelle pour le vrai MLS group ID (joinedGroupId) ET pour l'ID de l'enveloppe
          // WS (groupId), qui peuvent différer quand le Welcome est livré via un ancien channel migré.
          const effectiveMlsId = joinedGroupId || groupId!;
          try {
            await mlsService.registerMember(effectiveMlsId, userId);
          } catch {
            /* non-bloquant */
          }
          try {
            await mlsService.updateInvitationStatus(
              mlsService.getDeviceId(),
              userId,
              effectiveMlsId,
              'welcome_received'
            );
          } catch {
            /* non-bloquant */
          }
          if (groupId && groupId !== effectiveMlsId) {
            try {
              await mlsService.updateInvitationStatus(
                mlsService.getDeviceId(),
                userId,
                groupId,
                'welcome_received'
              );
            } catch {
              /* non-bloquant */
            }
          }

          // Si le MLS group ID diffère de la clé de conversation (convoKey), re-keyer la map
          // pour que les commits suivants soient routés vers le bon groupe WASM.
          // Cas typique : Welcome livré via l'enveloppe de l'ancien groupe mort,
          // mais la Welcome interne référence le successeur MLS réel.
          const needsRekey = joinedGroupId && joinedGroupId !== convoKey;
          const effectiveKey = needsRekey ? joinedGroupId : convoKey;

          if (needsRekey) {
            log(`[WELCOME] Re-clé "${convoKey}" → "${effectiveKey}" (MLS group ID mismatch)`);
            const targetConvo = conversations.get(effectiveKey);
            const rekeyed = targetConvo
              ? { ...targetConvo, isReady: true }
              : { ...convo, id: effectiveKey, isReady: true };
            conversations.delete(convoKey);
            if (storage) storage.deleteConversation(convoKey).catch(() => {});
            if (getSelectedContact() === convoKey) setSelectedContact(effectiveKey);
            epochRecoveryGroups.delete(convoKey);
            epochRecoveryGroups.delete(effectiveKey);
            // Empêcher les welcome_request futurs pour l'ancien groupId (groupe mort/migré).
            welcomeRequestedForUnknownGroups.add(convoKey);
            localStorage.removeItem(`discovery_pending:${groupId}`);
            conversations.set(effectiveKey, rekeyed);
            if (storage) await saveConversation(effectiveKey);
          } else {
            if (!wasReady) {
              // Placeholder → conversation activée pour la première fois.
              conversations.set(convoKey, { ...convo, isReady: true });
              localStorage.removeItem(`discovery_pending:${groupId}`);
              if (storage) await saveConversation(convoKey);
            } else {
              // Re-bootstrap : la conversation était active. On force isReady=true
              // (déjà vrai, mais on rafraîchit le store pour déclencher la réactivité).
              conversations.set(convoKey, { ...convo, isReady: true });
            }
            // Nettoyer le flag de récupération d'epoch si actif.
            epochRecoveryGroups.delete(convoKey);
            epochRecoveryGroups.delete(groupId!);
          }

          // Si le nom du groupe ressemble à un UUID, résoudre le vrai nom depuis l'API (non-bloquant).
          const renamedConvo = conversations.get(effectiveKey);
          if (renamedConvo && isRawId(renamedConvo.name)) {
            (async () => {
              try {
                let authHeader: Record<string, string> = {};
                try {
                  const { getToken } = await import('$lib/stores/auth');
                  const token = await getToken();
                  if (token) authHeader = { Authorization: `Bearer ${token}` };
                } catch {
                  /* silent */
                }
                const r = await fetch(`${historyBaseUrl}/api/mls/groups/${effectiveKey}`, {
                  headers: authHeader,
                });
                if (r.ok) {
                  const d = await r.json();
                  if (d?.name && !isRawId(d.name)) {
                    const c = conversations.get(effectiveKey);
                    if (c) {
                      conversations.set(effectiveKey, { ...c, name: d.name });
                      if (storage) saveConversation(effectiveKey).catch(() => {});
                      log(`[WELCOME] Nom résolu pour "${effectiveKey}": "${d.name}"`);
                    }
                  }
                }
              } catch {
                /* non-blocking */
              }
            })();
          }
        } catch (welcomeErr) {
          const welcomeErrMsg = String(welcomeErr);
          // GroupAlreadyExists / "already" / "duplicate" / "exists" : le groupe est déjà
          // dans le WASM (Welcome re-livré après un saveState raté). On persiste maintenant
          // pour éviter de re-boucler indéfiniment sur SYNC après chaque reload, puis ACK.
          if (welcomeErrMsg.includes('GroupAlreadyExists')) {
            log(`[WELCOME] Groupe ${convoKey} déjà rejoint - sauvegarde état MLS avant ACK`);
            try {
              const stBytes = await mlsService.saveState(pin);
              await saveMlsState(userId, stBytes);
              const staleConvo = conversations.get(convoKey);
              if (staleConvo) {
                conversations.set(convoKey, { ...staleConvo, isReady: true });
                localStorage.removeItem(`discovery_pending:${groupId}`);
                if (storage) await saveConversation(convoKey);
              }
            } catch {
              /* non-bloquant */
            }
            return true;
          }
          // CannotDecryptOwnMessage / NoMatchingKeyPackage : Welcome destiné à un autre
          // device → ACK silencieux pour débloquer la queue.
          if (
            welcomeErrMsg.includes('CannotDecryptOwnMessage') ||
            welcomeErrMsg.includes('NoMatchingKeyPackage')
          ) {
            console.warn(
              `[MLS] Redundant welcome (wrong device) - skipping: ${welcomeErrMsg.slice(0, 200)}`
            );
            return true;
          }
          // Échec réel (réseau, corruption temporaire…) → laisser en queue pour retry.
          // On retire convoKey de epochRecoveryGroups pour que la prochaine erreur
          // sur ce groupe puisse re-déclencher sendReinviteRequest si nécessaire.
          epochRecoveryGroups.delete(convoKey);
          epochRecoveryGroups.delete(groupId!);
          log(`[MLS] Welcome processing failed (${welcomeErrMsg}) - kept in queue for retry`);
          console.error(
            `[MLS] processWelcome failed for known group ${convoKey}:`,
            welcomeErrMsg.slice(0, 200)
          );
          return false;
        }
        return true;
      }

      // Process message for known conversation
      if (convoKey && !isWelcome) {
        const convo = conversations.get(convoKey)!;
        try {
          resetWasmDuplicateDeliveryFlag(); // évite qu'un flag résiduel contamine ce message
          const decryptedBytes = await mlsService.processIncomingMessage(convo.id, content);
          log(
            `[MLS] processIncomingMessage(${convo.id}) → ${decryptedBytes ? decryptedBytes.length + ' octets déchiffrés' : 'null (commit structural ou payload vide)'}`
          );

          // Persister l'état MLS : immédiat sur commit (epoch avancée), différé sinon.
          if (isCommit) {
            persistMlsStateNow();
          } else {
            scheduleMlsStatePersist();
          }

          if (decryptedBytes) {
            // Any decrypted payload means local state is healthy again.
            groupNullAppFailures.delete(convoKey);
            const msg = decodeAppMessage(decryptedBytes);
            const msgType = msg?.text
              ? 'text'
              : msg?.reply
                ? 'reply'
                : msg?.reaction
                  ? 'reaction'
                  : msg?.media
                    ? 'media'
                    : msg?.system
                      ? 'system'
                      : msg?.call
                        ? 'call'
                        : 'inconnu';
            log(
              `[MLS] Type décodé: ${msgType}${msg?.messageId ? ` id=${msg.messageId}` : ''} pour "${convoKey}"`
            );

            if (msg?.text || msg?.reply || msg?.media) {
              const envelope = appMsgToEnvelope(msg, deliveryMeta?.queuedCreatedAt);
              if (envelope) {
                const stableId =
                  normalizeMessageId(msg.messageId) ??
                  normalizeMessageId(deliveryMeta?.queuedMessageId);
                if (stableId) envelope.options.messageId = stableId;
                await addMessageToChat(senderNorm, envelope.content, convoKey, {
                  ...envelope.options,
                  serverTimestamp: deliveryMeta?.queuedCreatedAt,
                });
              }
              return true;
            }

            if (msg?.reaction) {
              const msgId = msg.reaction.messageId ?? '';
              const reactions = messageReactions.get(msgId) || [];
              const emoji = msg.reaction.emoji ?? '';
              // Add-idempotent: duplicate delivery must not cancel a reaction.
              // Removal is handled exclusively by the remove_reaction system event.
              const updated = addMessageReaction(reactions, senderNorm, emoji);
              if (!updated) return true; // already present or cap reached - no-op
              messageReactions.set(msgId, updated);

              // Also update the message object in conversations so the {#each} re-renders.
              // messageReactions.set() alone does not trigger Svelte's {#each} to re-evaluate
              // its {#const} bindings - only a conversations.set() does (via visibleMessageGroups).
              const convo = conversations.get(convoKey);
              if (convo) {
                const msgIdx = convo.messages.findIndex((m) => m.id === msgId);
                if (msgIdx !== -1) {
                  const nextMsgs = [...convo.messages];
                  nextMsgs[msgIdx] = { ...nextMsgs[msgIdx], reactions: updated };
                  conversations.set(convoKey, { ...convo, messages: nextMsgs });
                  if (storage) {
                    const target = nextMsgs[msgIdx];
                    try {
                      await storage.saveMessage(
                        {
                          id: target.id,
                          conversationId: convoKey,
                          senderId: target.senderId,
                          content: target.content,
                          timestamp: target.timestamp.getTime(),
                          readBy: target.readBy,
                          reactions: updated,
                        },
                        pin
                      );
                    } catch {
                      // Non-blocking
                    }
                  }
                }
              }

              log(`[REACTION] ${senderNorm} a reagi avec ${msg.reaction.emoji}`);
              return true;
            }

            if (msg?.call) {
              if (onCallSignal && groupId) {
                onCallSignal(senderNorm, groupId, msg.call);
              }
              return true;
            }

            if (msg?.system) {
              const event = msg.system.event ?? '';

              let data: any = {};
              try {
                if (msg.system.data) data = JSON.parse(msg.system.data);
              } catch {
                log(`[MLS] system.data malformé pour event="${event}" sur "${convoKey}" - discard`);
                return true;
              }
              return handleSystemEvent(event, data, {
                ...deps,
                convo,
                convoKey,
                senderNorm,
                persistMlsStateNow,
                deliveryMeta,
              });
            }

            // Guard: if the proto decoded successfully but the type is unknown,
            // never render it - system/receipt messages must never appear in the UI.
            if (msg !== null) {
              log(`[MLS] Unknown AppMessage type for "${convoKey}" - not rendered`);
              console.warn(`[MLS] Unknown AppMessage type - skipping render for group ${convoKey}`);
            }
          } else if (!isCommit && !epochRecoveryGroups.has(convoKey)) {
            // WASM logged a known-harmless duplicate error (SecretReuseError / out of bounds)
            // synchronously before returning null - ACK silently, do not count toward recovery.
            if (consumeWasmDuplicateDeliveryFlag()) {
              return true;
            }
            // Repeated null on non-commit traffic is a strong signal of local MLS
            // divergence (message is routed but cannot be decrypted into app payload).
            const nullCount = (groupNullAppFailures.get(convoKey) ?? 0) + 1;
            groupNullAppFailures.set(convoKey, nullCount);
            log(
              `[RECOVER] Message non-commit non déchiffrable sur "${convoKey}" (${nullCount}/${NULL_APP_THRESHOLD})`
            );
            if (nullCount >= NULL_APP_THRESHOLD) {
              log(`[RECOVER] Etat MLS suspect sur "${convoKey}" - oubli MLS + reinvite_request`);
              console.warn(
                `[RECOVER] MLS state suspect on "${convoKey}" - forget + reinvite_request`
              );
              await triggerEpochRecovery(convoKey);
            }
          }
          // Reset phantom failure counter on any successful processing
          groupMlsFailures.delete(convoKey);
          return true;
        } catch (_e) {
          const errMsg = String(_e);
          if (errMsg.includes('CannotDecryptOwnMessage')) {
            return true; // ACK it so it isn't resent
          }

          // Ratchet de génération dépassé : message déjà traité ou rélivraison de l'historique
          // après reconnexion. La clé symétrique est consommée, aucune récupération possible.
          if (
            errMsg.includes('TooDistantInThePast') ||
            errMsg.includes('CiphertextGenerationOutOfBounds') ||
            errMsg.includes('SecretReuseError') ||
            errMsg.includes('out of bounds')
          ) {
            return true; // ACK silencieux - irrecuperable
          }

          // GAP_QUEUED: Rust stored the message in SQLite pending_mls_messages for
          // background retry. ACK the delivery-queue entry (the SQLite copy is the
          // durable retry buffer). For proactive epoch gaps, also trigger re-sync.
          if (errMsg.includes(RUST_GAP_QUEUED_SIGNAL)) {
            const meM = errMsg.match(/msg_epoch=(\d+)/);
            const geM = errMsg.match(/group_epoch=(\d+)/);
            if (meM && geM) {
              const me = parseInt(meM[1], 10);
              const ge = parseInt(geM[1], 10);
              log(
                `[GAP_QUEUED] Epoch gap sur "${convoKey}" (local: ${ge}, msg: ${me}) - message mis en SQLite, déclenchement resync`
              );
              console.warn(
                `[GAP_QUEUED] Epoch gap on "${convoKey}" (local=${ge}, msg=${me}) - queued in SQLite, triggering resync`
              );
              if (me > ge) {
                await triggerEpochRecovery(convoKey, me);
              }
            } else {
              log(`[GAP_QUEUED] Sender ratchet gap sur "${convoKey}" - message mis en SQLite`);
              console.warn(
                `[GAP_QUEUED] Sender ratchet gap on "${convoKey}" - queued in SQLite for background retry`
              );
            }
            return true; // ACK delivery queue; SQLite copy retried by background task
          }

          // Stale message (msg_epoch < group_epoch): our own echoed commit or a
          // commit already applied by another path.  The Rust layer handles most of
          // these, but some slip through (e.g. PublicMessage commits).  ACK silently.
          // Future epoch (msg_epoch > group_epoch): our local state is behind - drop
          // the stale MLS state and trigger a re-sync via reinvite_request.
          const meMatch = errMsg.match(/msg_epoch=(\d+)/);
          const geMatch = errMsg.match(/group_epoch=(\d+)/);
          if (meMatch && geMatch) {
            const me = parseInt(meMatch[1], 10);
            const ge = parseInt(geMatch[1], 10);
            if (me < ge) {
              return true; // Stale - already processed
            }
            if (me > ge) {
              log(
                `[RECOVER] Epoch périmée sur "${convoKey}" (local: ${ge}, msg: ${me}) - oubli MLS + reinvite_request`
              );
              console.warn(
                `[RECOVER] Stale epoch on "${convoKey}" (local=${ge}, msg=${me}) - forget + reinvite`
              );
              await triggerEpochRecovery(convoKey, me);
            }
            // me === ge + SenderDataDecryption = secrets divergés (race condition)
            if (me === ge && errMsg.toLowerCase().includes('senderdata')) {
              log(
                `[RECOVER] Divergence secrets (SenderDataDecryption) sur "${convoKey}" (epoch: ${ge}) - oubli MLS + reinvite_request`
              );
              console.warn(
                `[RECOVER] SenderData secret divergence on "${convoKey}" (epoch=${ge}) - forget + reinvite`
              );
              await triggerEpochRecovery(convoKey, ge);
            }
            return true; // ACK toujours pour les erreurs d'epoch
          }

          if (errMsg.includes('WrongEpoch')) {
            return true; // WrongEpoch sans numéros parsables - ACK silencieux
          }

          // SenderDataDecryption fallback sans epoch parsable - même récupération
          if (errMsg.toLowerCase().includes('senderdata')) {
            log(
              `[RECOVER] Divergence secrets (SenderDataDecryption) sur "${convoKey}" - oubli MLS + reinvite_request`
            );
            console.warn(
              `[RECOVER] SenderData secret divergence (no epoch) on "${convoKey}" - forget + reinvite`
            );
            await triggerEpochRecovery(convoKey);
            return true;
          }

          log(`Erreur message de ${senderNorm} (groupe connu): ${errMsg}`);
          console.error(
            `[MLS] Message error from ${senderNorm} on ${convoKey}:`,
            errMsg.slice(0, 200)
          );
          groupNullAppFailures.delete(convoKey);

          // Détection de groupe fantôme : le groupId existe dans nos conversations
          // mais n'est plus dans l'état WASM MLS → nettoyage automatique après N échecs
          const isPhantom =
            errMsg.toLowerCase().includes('groupe introuvable') ||
            errMsg.toLowerCase().includes('group not found');
          // Fix D: ignorer la détection fantôme pour les groupes en attente de re-Welcome
          if (isPhantom && !epochRecoveryGroups.has(convoKey)) {
            const failures = (groupMlsFailures.get(convoKey) ?? 0) + 1;
            groupMlsFailures.set(convoKey, failures);
            log(
              `[WARN] Groupe fantome potentiel "${convoKey}" (echec ${failures}/${PHANTOM_THRESHOLD})`
            );
            console.warn(
              `[MLS] Phantom group suspected: "${convoKey}" (failure ${failures}/${PHANTOM_THRESHOLD})`
            );
            if (failures >= PHANTOM_THRESHOLD) {
              groupMlsFailures.delete(convoKey);
              groupNullAppFailures.delete(convoKey);
              // Une seule tentative de récupération par session - si déjà en cours,
              // escalade immédiate vers Poison Pill.
              if (recoveryInProgress.has(convo.id)) {
                log(`[POISON_PILL] Récupération déjà tentée pour "${convoKey}" - Poison Pill`);
                await poisonPill(convo.id);
                return true;
              }
              log(
                `[RECOVER] Groupe fantôme "${convoKey}" après ${failures} échecs - lancement récupération (1 seule tentative)`
              );
              const convoForRecovery = conversations.get(convoKey);
              if (convoForRecovery) {
                recoveryInProgress.add(convo.id);
                recoverDeadGroup(convoForRecovery.id, {
                  mlsService,
                  storage,
                  userId,
                  pin,
                  conversations,
                  getSelectedContact,
                  setSelectedContact,
                  saveConversation,
                  deleteConversation,
                  log,
                })
                  .then(() => {
                    recoveryInProgress.delete(convo.id);
                    log(`[RECOVER] Récupération terminée pour "${convoKey}" - flag effacé`);
                  })
                  .catch(async (e) => {
                    log(
                      `[POISON_PILL] Récupération échouée pour "${convoKey}": ${String(e)} - Poison Pill`
                    );
                    console.warn(`[POISON_PILL] recoverDeadGroup failed for ${convoKey}:`, e);
                    await poisonPill(convo.id);
                  });
              }
            }
          }

          return false;
        }
      }

      if (!isWelcome) {
        // Buffer le message - le Welcome est peut-être encore en transit.
        // Sans ce buffer, les commits qui arrivent avant le Welcome sont perdus,
        // créant une divergence d'epoch permanente (AeadError).
        if (groupId) {
          const buf = pendingGroupMessages.get(groupId) ?? [];
          // Safety net : si c'est le premier message pour ce groupe inconnu, envoyer un
          // welcome_request pour réveiller un membre online - au cas où syncConnectionAfterWsOpen
          // n'aurait pas couvert ce groupe (absent des memberships au démarrage).
          if (
            buf.length === 0 &&
            !conversations.has(groupId) &&
            !welcomeRequestedForUnknownGroups.has(groupId)
          ) {
            welcomeRequestedForUnknownGroups.add(groupId);
            mlsService.sendWelcomeRequest(groupId).catch(() => {});
            log(`[BUFFER] welcome_request envoyé (premier commit pour groupe inconnu ${groupId})`);
            // Démarre le minuteur de sécurité : si Welcome n'arrive pas dans 30s, Poison Pill.
            // Annulé dans le handler Welcome dès que processWelcome réussit.
            if (!welcomeTimeouts.has(groupId)) {
              const t = setTimeout(() => {
                welcomeTimeouts.delete(groupId);
                log(
                  `[POISON_PILL] Welcome non reçu après 30s pour ${groupId} - Poison Pill (timeout)`
                );
                console.warn(`[POISON_PILL] Welcome timeout for group ${groupId}`);
                poisonPill(groupId);
              }, 30_000);
              welcomeTimeouts.set(groupId, t);
            }
          }
          if (buf.length >= BUFFER_MAX_PER_GROUP) {
            // Buffer plein : écrêter en supprimant le message le plus ancien pour faire de la place.
            // On ne déclenche plus Poison Pill ici - le timer de 30s s'en charge si Welcome ne vient pas.
            buf.shift();
            log(
              `[BUFFER] Buffer plein pour ${groupId} - oldest message écrêté (${BUFFER_MAX_PER_GROUP} max)`
            );
          }
          buf.push({ sender, content });
          pendingGroupMessages.set(groupId, buf);
          log(
            `[BUFFER] Message bufferise pour groupe ${groupId} (${buf.length}/${BUFFER_MAX_PER_GROUP} en attente)`
          );
          return false; // Keep in queue: Welcome may also be queued and will be retried
        }
        log(`Ignoré: message sans groupe ni conversation`);
        return false;
      }

      // Unknown group → Process Welcome message.
      // Démarrer le fetch de métadonnées immédiatement (groupId connu dès ici) afin qu'il
      // s'exécute en parallèle de processWelcome plutôt qu'en séquence après.
      const groupMetaPromise: Promise<{ name?: string; isGroup?: boolean } | null> = (async () => {
        try {
          const { getToken } = await import('$lib/stores/auth');
          const token = await getToken().catch(() => null);
          const authHeader: Record<string, string> = token
            ? { Authorization: `Bearer ${token}` }
            : {};
          const r = await fetch(`${historyBaseUrl}/api/mls/groups/${groupId}`, {
            headers: authHeader,
          });
          return r.ok ? await r.json() : null;
        } catch {
          return null;
        }
      })();

      try {
        const joinedGroupId = await mlsService.processWelcome(content, ratchetTreeBytes);
        console.log(`[WS RCV] processWelcome ✓ → joinedGroupId=${joinedGroupId}`);

        // Annuler le minuteur de sécurité - Welcome reçu à temps.
        const pendingTimer = welcomeTimeouts.get(groupId ?? joinedGroupId);
        if (pendingTimer !== undefined) {
          clearTimeout(pendingTimer);
          welcomeTimeouts.delete(groupId ?? joinedGroupId);
        }

        // Register this device as a group member on the server so the gateway
        // routes future commits/messages to us.  Without this, we join the MLS
        // tree locally but the gateway doesn't know we're a member.
        try {
          await mlsService.registerMember(joinedGroupId, userId);
        } catch {
          // Non-blocking: worst case we miss commits until next sync repairs it
        }

        // Mark this device as welcome_received so it can later process
        // pending invitations for future new devices via getPendingInvitations.
        try {
          await mlsService.updateInvitationStatus(
            mlsService.getDeviceId(),
            userId,
            joinedGroupId,
            'welcome_received'
          );
        } catch {
          // Non-blocking: status will be corrected on next sync
        }

        // Persiste l'état MLS en arrière-plan. Un crash ici déclencherait le détecteur
        // de groupe fantôme au prochain démarrage, qui lancerait recoverDeadGroup - chemin
        // de récupération acceptable. On ne bloque plus le pipeline de messages le temps
        // d'Argon2 (~1-2s sur mobile).
        mlsService
          .saveState(pin)
          .then((b) => saveMlsState(userId, b))
          .catch(() => {});

        // Attendre les métadonnées - le fetch a démarré avant processWelcome, il est
        // souvent déjà résolu à ce stade (le RTT réseau était masqué par le WASM).
        const gData = await groupMetaPromise;
        const groupName = gData?.name ?? senderNorm;
        const isGroupFromApi: boolean | null =
          typeof gData?.isGroup === 'boolean' ? gData.isGroup : null;

        let isDirect = false;
        let directPeerId = '';

        // Determine if this is a direct conversation:
        // 1. Backend explicit isGroup=false → DM; peer from name or fallback to sender.
        // 2. isGroup=null + name matches "userA::userB" → legacy DM detection.
        // 3. isGroup=true → group; isDirect stays false.
        const peerFromName = parseDirectPeerFromName(groupName, userId);
        if (isGroupFromApi === false) {
          isDirect = true;
          directPeerId = peerFromName ?? senderNorm;
        } else if (isGroupFromApi === null && peerFromName) {
          isDirect = true;
          directPeerId = peerFromName;
        }

        // Since the map is keyed by groupId, find directly.
        let newConvoKey = joinedGroupId; // default - map key = groupId
        let matchedExisting = false;

        if (isDirect) {
          const existingDirect = Array.from(conversations.entries()).find(([, convo]) => {
            if ((convo.conversationType ?? 'group') !== 'direct') return false;
            return (convo.directPeerId ?? convo.contactName).toLowerCase() === directPeerId;
          });
          if (existingDirect) {
            newConvoKey = existingDirect[0];
            matchedExisting = true;
          }
        } else {
          // For groups: check if a placeholder already exists with this groupId
          if (conversations.has(joinedGroupId)) {
            newConvoKey = joinedGroupId;
            matchedExisting = true;
          }
        }

        if (matchedExisting) {
          const convo = conversations.get(newConvoKey)!;
          const updated = {
            ...convo,
            id: joinedGroupId,
            name: isDirect ? directPeerId : groupName,
            isReady: true,
          };
          // If the groupId changed (bootstrap replaced the old group), re-key the map
          // so that future messages routed by joinedGroupId find this conversation.
          if (newConvoKey !== joinedGroupId) {
            conversations.delete(newConvoKey);
            if (storage) storage.deleteConversation(newConvoKey).catch(() => {});
            if (getSelectedContact() === newConvoKey) setSelectedContact(joinedGroupId);
            epochRecoveryGroups.delete(newConvoKey);
            log(
              `[WELCOME] Migration groupe: ${newConvoKey} → ${joinedGroupId} (contact: ${isDirect ? directPeerId : groupName})`
            );
            newConvoKey = joinedGroupId;
          }
          conversations.set(newConvoKey, updated);
          // Annuler la récupération d'epoch en cours pour ce groupe (Welcome reçu)
          epochRecoveryGroups.delete(newConvoKey);
          if (storage) await saveConversation(newConvoKey);
        } else {
          // Create new conversation (key = joinedGroupId)
          conversations.set(newConvoKey, {
            id: joinedGroupId,
            contactName: isDirect ? directPeerId : groupName,
            name: isDirect ? directPeerId : groupName,
            messages: [],
            isReady: true,
            mlsStateHex: null,
            conversationType: isDirect ? 'direct' : 'group',
            ...(isDirect ? { directPeerId: directPeerId } : {}),
          });
          if (storage) await saveConversation(newConvoKey);
        }

        // Background: fetch history so the new conversation isn't empty
        try {
          await loadHistoryForConversation(newConvoKey, joinedGroupId);
        } catch {
          // Silent fallback if history fetch fails
        }

        // Replay des messages bufferisés (commits arrivés avant le Welcome).
        // Les commits font avancer l'epoch ; les messages applicatifs sont déchiffrés.
        const buffered = pendingGroupMessages.get(joinedGroupId);
        if (buffered && buffered.length > 0) {
          pendingGroupMessages.delete(joinedGroupId);
          log(`[BUFFER] Replay ${buffered.length} message(s) bufferise(s) pour ${joinedGroupId}`);
          const replayBatch: Array<
            { senderId: string; content: string } & import('$lib/types').AddMessageToChatOptions
          > = [];
          let replaySeq = 0;
          for (const msg of buffered) {
            try {
              const decBytes = await mlsService.processIncomingMessage(joinedGroupId, msg.content);
              if (decBytes) {
                try {
                  const appMsg = decodeAppMessage(decBytes);
                  if (appMsg) {
                    const envelope = appMsgToEnvelope(appMsg);
                    if (envelope) {
                      replayBatch.push({
                        senderId: msg.sender.toLowerCase(),
                        content: envelope.content,
                        ...envelope.options,
                        ingestSequence: replaySeq++,
                      });
                    }
                  }
                } catch {
                  /* ignore decode errors during replay */
                }
              }
            } catch (e) {
              const errMsg = String(e);
              if (!errMsg.includes('CannotDecryptOwnMessage') && !errMsg.includes('WrongEpoch')) {
                log(`[BUFFER] Erreur replay: ${errMsg.slice(0, 150)}`);
              }
            }
          }
          if (replayBatch.length > 0) {
            if (batchAddMessages) {
              await batchAddMessages(replayBatch, newConvoKey);
            } else {
              for (const item of replayBatch) {
                await addMessageToChat(item.senderId, item.content, newConvoKey, item);
              }
            }
          }
          // Sauvegarder l'état MLS une seule fois après tout le replay
          try {
            const stBytes = await mlsService.saveState(pin);
            await saveMlsState(userId, stBytes);
          } catch {
            /* non-blocking */
          }
        }

        return true;
      } catch (_e) {
        const errStr = String(_e);
        console.error(`[WS RCV] processWelcome FAILED groupId=${groupId}:`, errStr.slice(0, 200));
        if (errStr.includes('NoMatchingKeyPackage')) {
          // Le KeyPackage utilisé pour générer ce Welcome a été consommé (one-time prekey)
          // ou l'appareil a été réinitialisé. Ce Welcome est inutilisable pour ce device.
          // On demande au groupe de renvoyer un Welcome avec un nouveau KeyPackage.
          log(
            `[WELCOME] KeyPackage introuvable pour groupe ${groupId} - Welcome inutilisable. ` +
              `Envoi d'un welcome_request pour se faire ré-inviter. Erreur: ${errStr.slice(0, 200)}`
          );
          console.error(
            `[WELCOME] NoMatchingKeyPackage for group ${groupId} - sending welcome_request`
          );
          if (groupId) {
            mlsService.sendWelcomeRequest(groupId).catch((e) => {
              log(`[WELCOME] sendWelcomeRequest échoué pour groupe=${groupId}: ${e}`);
            });
          }
          // Retourner false pour que le caller ACK ce Welcome (il est définitivement inutile).
          // On retire groupId de epochRecoveryGroups pour permettre à la prochaine erreur
          // de re-déclencher sendReinviteRequest si besoin.
          // La one-time prekey est consommée - ce Welcome est définitivement inutile pour ce device.
          // On a déjà envoyé un welcome_request pour se faire ré-inviter avec un nouveau KeyPackage.
          // ACK (return true) : inutile de retenter à chaque reconnexion.
          epochRecoveryGroups.delete(groupId!);
          return true;
        }
        // Erreur inattendue (corruption, mismatch de cipher suite…) : on ne retourne PAS true.
        // On relance l'exception pour que processQueue n'ACK PAS le message côté serveur.
        // Ainsi, le Welcome reste en file de livraison et sera retenté à la prochaine connexion.
        // On retire groupId de epochRecoveryGroups pour la même raison que ci-dessus.
        epochRecoveryGroups.delete(groupId!);
        log(
          `[WELCOME] Erreur irrécupérable processWelcome pour groupe ${groupId} - NE PAS ACK, retry à la prochaine connexion. Erreur: ${errStr.slice(0, 300)}`
        );
        console.error(
          `[WELCOME] Unrecoverable processWelcome error for group ${groupId} - will retry on reconnect:`,
          errStr.slice(0, 200)
        );
        throw _e;
      }
    }
  );
}
