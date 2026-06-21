import { parseDirectPeerFromName } from '$lib/utils/chat/conversations';
import { decodeAppMessage } from '$lib/proto/codec';
import { appMsgToEnvelope, normalizeMessageId } from '$lib/utils/chat/messageUtils';
import { addMessageReaction } from '$lib/utils/chat/messageReactions';
import { requestReAdd, cancelReAdd } from '$lib/utils/chat/recovery';
import { resolveTerminalGroup } from '$lib/utils/chat/groupSyncEligibility';
import { handleSystemEvent } from './systemMessageHandler';
import { handleChannelEvent } from './channelEventHandler';
import {
  installWasmDuplicateDeliveryLogInterceptor,
  resetWasmDuplicateDeliveryFlag,
  consumeWasmDuplicateDeliveryFlag,
} from '../wasmLogShim';
import type { IncomingDeliveryMeta } from '../incomingDelivery';
import { classifyIncomingDecryptError } from '../mlsDecryptError';
import { createMlsStatePersister } from '../mlsStatePersister';
import { installMlsStatePersisterLifecycle } from '../mlsStatePersisterLifecycle';
import { registerMlsStatePersister } from '../mlsStatePersisterRegistry';
import type { MessageHandlerDeps } from './deps';
export type { MessageHandlerDeps } from './deps';

/** Message en attente de Welcome dans le buffer court. */
type PendingMsg = { sender: string; content: Uint8Array };

/**
 * Échecs `NoMatchingKeyPackage` consécutifs autorisés par groupe avant d'escalader
 * d'un simple welcome_request (l'invitant nous ré-ajoute) vers une recovery complète
 * (requestReAdd). Empêche le livelock Welcome ↔ welcome_request quand le ré-ajout
 * échoue durablement (KeyPackage publié orphelin de sa clé privée locale).
 */
const MAX_NOMATCH_KP_RETRIES = 3;

/**
 * Délai pendant lequel un groupe peut rester en gap d'epoch (`msg_epoch > group_epoch`)
 * avant d'escalader vers une recovery complète. Au-delà, les commits manqués ne
 * reviendront pas (purgés de la file serveur) : on oublie l'état forké et on redemande
 * un Welcome pour rejoindre à l'epoch courante.
 */
const EPOCH_GAP_ESCALATION_MS = 30_000;

/** Compteur d'échecs NoMatchingKeyPackage par groupe terminal, pour l'escalade. */
const noMatchKpFailures = new Map<string, number>();

/**
 * Installe le handler de messages MLS.
 *
 * Architecture simplifiée (RFC 9420 + OpenMLS fork-resolution) :
 * - Welcome → traitement + replay du buffer
 * - Groupe inconnu → buffer 10s + welcome_request → requestReAdd si timeout
 * - Groupe connu → déchiffrement → affichage / requestReAdd si out-of-sync
 *
 * Invariants :
 * 1. Tout message est ACKé exactement une fois.
 * 2. `requestReAdd` remplace toute escalade (pas de Poison Pill, pas de compteurs).
 * 3. L'état recovery (timers) est en mémoire seulement - reset à chaque session.
 */
export function setupMessageHandler(deps: MessageHandlerDeps): void {
  const { mlsService, pin, userId, log } = deps;

  installWasmDuplicateDeliveryLogInterceptor();

  const statePersister = createMlsStatePersister({ mlsService, pin, userId, log });
  registerMlsStatePersister(statePersister);
  installMlsStatePersisterLifecycle(statePersister);

  // The persister satisfies BulkIngestObserver (onBulkIngestStart/End): it defers the encrypted
  // MLS checkpoint to one flush per drain. The UI render buffer registers its own observer in
  // sessionAuth; the two are independent subscribers, no longer multiplexed over one hook.
  mlsService.addBulkIngestObserver(statePersister);

  // Buffer court : commits arrivant avant leur Welcome (max 10s d'attente)
  const pendingBuffer = new Map<
    string,
    { msgs: PendingMsg[]; timer: ReturnType<typeof setTimeout> }
  >();

  // Timers de recovery par groupe - map partagée avec la couche connexion
  // (connectionRecoveryTimers) : un seul timer armé par groupe quelle que soit la source.
  const recoveryTimers = deps.recoveryTimers;

  // Timestamp (ms) du 1er gap d'epoch non résolu par groupe. Effacé dès qu'un message
  // se déchiffre (gap résorbé). Sert à escalader un groupe durablement forké-en-retard.
  const epochGapSince = new Map<string, number>();

  // Callback partagé pour tout cas "hors-sync"
  const onOutOfSync = async (groupId: string) => {
    log(`[PIPELINE] Hors-sync pour ${groupId.slice(0, 8)}… - requestReAdd`);
    await requestReAdd(groupId, deps, recoveryTimers);
  };

  // Événements canal (channel membership, epoch_rejected, etc.)
  mlsService.onChannelEvent = (event) => {
    void handleChannelEvent(event, {
      conversations: deps.conversations,
      addMessageToChat: deps.addMessageToChat,
      onChannelMemberJoined: deps.onChannelMemberJoined,
      onChannelMemberKicked: deps.onChannelMemberKicked,
      onChannelUpdated: deps.onChannelUpdated,
      onChannelDeleted: deps.onChannelDeleted,
      onWorkspaceUpdated: deps.onWorkspaceUpdated,
      log,
      onOutOfSync,
    });
  };

  mlsService.onMessage(
    async (sender, content, groupId, isWelcome, ratchetTreeBytes, isCommit, deliveryMeta) => {
      const senderNorm = sender.toLowerCase();

      // ── Welcome ──────────────────────────────────────────────────────────────
      if (isWelcome) {
        return handleWelcome({
          sender: senderNorm,
          content,
          groupId,
          ratchetTreeBytes,
          deps,
          statePersister,
          pendingBuffer,
          recoveryTimers,
        });
      }

      if (!groupId) return true; // ACK sans groupe - frame de contrôle

      // ── Groupe inconnu (pas dans le WASM local) ───────────────────────────
      const inGroup = mlsService.getLocalGroups().includes(groupId);
      if (!inGroup) {
        return handleUnknownGroup({
          sender: senderNorm,
          content,
          groupId,
          deps,
          pendingBuffer,
          recoveryTimers,
        });
      }

      // ── Groupe connu ─────────────────────────────────────────────────────
      return handleKnownGroup({
        sender: senderNorm,
        content,
        groupId,
        isCommit,
        deliveryMeta,
        deps,
        statePersister,
        onOutOfSync,
        epochGapSince,
      });
    }
  );
}

// ── Handlers internes ────────────────────────────────────────────────────────

interface WelcomeArgs {
  sender: string;
  content: Uint8Array;
  groupId: string | undefined;
  ratchetTreeBytes: Uint8Array | undefined;
  deps: MessageHandlerDeps;
  statePersister: ReturnType<typeof createMlsStatePersister>;
  pendingBuffer: Map<string, { msgs: PendingMsg[]; timer: ReturnType<typeof setTimeout> }>;
  recoveryTimers: Map<string, ReturnType<typeof setTimeout>>;
}

/**
 * Traite un message Welcome - pour un groupe connu ou inconnu.
 *
 * Toujours ACKé : un Welcome qui échoue ne peut pas être retraité
 * (key package consommé). On demande une ré-invitation si nécessaire.
 */
async function handleWelcome({
  sender,
  content,
  groupId,
  ratchetTreeBytes,
  deps,
  statePersister,
  pendingBuffer,
  recoveryTimers,
}: WelcomeArgs): Promise<boolean> {
  const {
    mlsService,
    userId,
    saveConversation,
    onGroupReady,
    log,
    batchAddMessages,
    addMessageToChat,
  } = deps;

  // Résoudre le groupe terminal dans la chaîne de successeurs.
  // Cas commun (aucun successeur) : 1 appel API - remplace fetchGroupMeta.
  // Chaîne de N reboots : N+1 appels, mais on atteint le terminal directement
  // sans jamais rejoindre un groupe mort intermédiaire.
  const { terminalId, groupMeta, hasChain } = await resolveTerminalGroup(mlsService, groupId ?? '');

  // Toute la lignée de successeurs est supprimée - ne pas rejoindre un groupe mort.
  if (groupMeta?.deletedAt) {
    log(
      `[WELCOME] Lignée ${(groupId ?? '').slice(0, 8)}…→${terminalId.slice(0, 8)}… supprimée - Welcome ignoré`
    );
    cancelReAdd(groupId ?? '', recoveryTimers);
    return true;
  }

  if (hasChain) {
    // Le groupe de l'enveloppe est mort - cibler le terminal à la place.
    const from = (groupId ?? '').slice(0, 8);
    const to = terminalId.slice(0, 8);
    cancelReAdd(groupId ?? '', recoveryTimers);
    if (mlsService.getLocalGroups().includes(terminalId)) {
      log(`[WELCOME] ${from}… → ${to}… déjà dans WASM - Welcome ignoré`);
    } else {
      log(`[WELCOME] ${from}… a successeur ${to}… - welcome_request vers groupe terminal`);
      await mlsService.registerMember(terminalId, userId).catch(() => {});
      await requestReAdd(terminalId, deps, recoveryTimers);
    }
    return true; // ACKé - Welcome pour groupe mort traité
  }

  // Welcome redélivré pour un groupe qu'on détient déjà localement (typiquement un requeue
  // serveur après un restart de l'app : le Welcome d'origine repart dans les pending).
  // Tenter de le (re)joindre échouerait sur NoMatchingKeyPackage - le KeyPackage du Welcome
  // a déjà été consommé lors de la jointure initiale, OpenMLS valide la clé AVANT de
  // détecter GroupAlreadyExists - ce qui déclencherait un welcome_request, donc un kick +
  // ré-ajout par l'invitant. Ce ré-ajout fait avancer l'epoch au-delà de nous et nous forke
  // durablement (group_epoch figé < msg_epoch). On traite donc le Welcome comme idempotent.
  if (mlsService.getLocalGroups().includes(terminalId)) {
    cancelReAdd(terminalId, recoveryTimers);
    noMatchKpFailures.delete(terminalId);
    const convo = deps.conversations.get(terminalId);
    if (convo && convo.lifecycle !== 'active') {
      deps.conversations.set(terminalId, { ...convo, lifecycle: 'active' });
      await saveConversation(terminalId).catch(() => {});
    }
    // Promotion serveur de la membership en 'active' - INDISPENSABLE meme sur ce chemin idempotent.
    // Cas reel : un device qui rejoint le groupe en ARRIERE-PLAN (Welcome via FCM/JNI) ne passe
    // pas par le chemin de join normal ci-dessous (qui appelle updateInvitationStatus). Quand il
    // revient au premier plan, le Welcome est redelivre mais le groupe est deja local -> on tombe
    // ici. Sans cet appel, sa ligne dm_device_group_memberships reste 'pending', donc la resolution
    // des destinataires (status='active') l'EXCLUT : il ne recoit jamais les messages en temps reel
    // ni en push (seulement via le rattrapage d'historique au reload). Fire-and-forget, idempotent.
    void mlsService
      .updateInvitationStatus(mlsService.getDeviceId(), userId, terminalId, 'active')
      .catch(() => {});
    onGroupReady?.(terminalId);
    log(`[WELCOME] ${terminalId.slice(0, 8)}… déjà détenu - Welcome redélivré ignoré (idempotent)`);
    return true;
  }

  // Section critique WASM sous le verrou MLS. La résolution du groupe terminal et les
  // contrôles de recovery ci-dessus tournent hors verrou (réseau pur) ; seul ce bloc WASM
  // contigu (processWelcome -> purge des prédécesseurs -> replay) doit rester exclusif.
  // Le drain n'auto-verrouille pas les Welcome (voir MlsPerGroupScheduler.drain), ce qui
  // évite de tenir le mutex pendant le préambule réseau et de bloquer le catch-up.
  await mlsService.runUnderMlsLock(async () => {
    try {
      // processWelcome retourne le groupId MLS effectif (peut différer de l'enveloppe de livraison).
      // Fallback sur le groupId de l'enveloppe si le WASM retourne undefined (ne devrait pas arriver).
      const joinedGroupId =
        (await mlsService.processWelcome(content, ratchetTreeBytes)) ?? groupId ?? '';

      // Annuler les timers en cours pour ce groupe (dans les deux maps : locale + connexion)
      const buf = pendingBuffer.get(joinedGroupId);
      if (buf) {
        clearTimeout(buf.timer);
        pendingBuffer.delete(joinedGroupId);
      }
      cancelReAdd(joinedGroupId, recoveryTimers);
      noMatchKpFailures.delete(joinedGroupId); // Welcome traité - reset l'escalade NoMatchingKeyPackage

      // Persister immédiatement après Welcome (epoch initialisée)
      statePersister.persistNow();

      // Purger du WASM les prédécesseurs dont le successeur est le groupe qu'on vient de rejoindre.
      // Isolé dans son propre try/catch : une erreur ici (ex. forgetGroup sur un groupe déjà absent)
      // ne doit pas tomber dans le catch de processWelcome et déclencher un welcome_request parasite.
      try {
        const otherLocalIds = mlsService.getLocalGroups().filter((id) => id !== joinedGroupId);
        // Pré-fetch des métas en parallèle : enchaîner les getGroupMeta en séquence
        // multiplierait les aller-retours réseau tenus sous le verrou MLS.
        const metas = await Promise.all(
          otherLocalIds.map((predId) =>
            mlsService.getGroupMeta(predId).then(
              (m) => ({ predId, m }),
              () => ({ predId, m: null })
            )
          )
        );
        let purgedAny = false;
        for (const { predId, m } of metas) {
          if (m?.successorId === joinedGroupId) {
            mlsService.forgetGroup(predId);
            purgedAny = true;
            log(`[WELCOME] Prédécesseur ${predId.slice(0, 8)}… purgé du WASM (successeur rejoint)`);
          }
        }
        // Un seul checkpoint chiffré (Argon2) pour l'ensemble des purges, pas un par prédécesseur.
        if (purgedAny) statePersister.persistNow();
      } catch (e) {
        log(`[WELCOME] Erreur purge prédécesseur (non bloquant) : ${String(e).slice(0, 80)}`);
      }

      // La purge de l'ancien groupe du Map et d'IndexedDB est déléguée :
      // - Map : upsertConversation (ci-dessous) supprime l'entrée prédécesseur quand il
      //   trouve le même pair DM sous un ancien groupId, et migre ses messages en mémoire.
      // - IndexedDB : mergeDirectConversationDuplicates au prochain login (Fix 1).
      //
      // Supprimer l'IndexedDB du prédécesseur ici effacerait les messages accumulés
      // avant que upsertConversation puisse les lire et les persister dans le successeur,
      // provoquant une perte visible jusqu'à réception du bundle historique.

      // Enregistrement côté serveur (idempotent - safety net si l'invitant n'a pas encore
      // appelé registerMember pour cet userId, ex. race dans inviteMembers/reboot).
      // Résultats non utilisés : lancés sans await pour ne pas retenir le verrou MLS pendant
      // deux aller-retours réseau (le groupe est déjà rejoint localement).
      void mlsService.registerMember(joinedGroupId, userId).catch(() => {});
      void mlsService
        .updateInvitationStatus(mlsService.getDeviceId(), userId, joinedGroupId, 'active')
        .catch(() => {});

      // groupMeta déjà récupéré par resolveTerminalGroup - pas de second appel HTTP.
      await upsertConversation(joinedGroupId, groupMeta, sender, userId, deps);

      // Replay des messages bufferisés (commits arrivés avant le Welcome)
      if (buf?.msgs.length) {
        for (const msg of buf.msgs) {
          try {
            const decBytes = await mlsService.processIncomingMessage(joinedGroupId, msg.content);
            if (decBytes) {
              const appMsg = decodeAppMessage(decBytes);
              if (appMsg) {
                const envelope = appMsgToEnvelope(appMsg);
                if (envelope) {
                  if (batchAddMessages) {
                    await batchAddMessages(
                      [{ senderId: msg.sender, content: envelope.content, ...envelope.options }],
                      joinedGroupId
                    );
                  } else {
                    await addMessageToChat(
                      msg.sender,
                      envelope.content,
                      joinedGroupId,
                      envelope.options
                    );
                  }
                }
              }
            }
          } catch {
            /* ignore erreurs de replay */
          }
        }
        statePersister.persistNow();
      }

      // Historique : délégué à onWelcomeProcessed (après reinject) pour ne pas bloquer
      // la queue sous le verrou MLS (createDecryptSession ré-acquiert le même mutex).
      onGroupReady?.(joinedGroupId);
      log(`[WELCOME] Groupe ${joinedGroupId.slice(0, 8)}… prêt`);
    } catch (e) {
      const err = String(e);
      if (err.includes('GroupAlreadyExists')) {
        // process_welcome a jeté AVANT l'insert : l'état OpenMLS du groupe existe dans le
        // storage provider mais PAS en mémoire (sinon le guard "déjà détenu" l'aurait traité
        // en amont). Le marquer "prêt" serait faux - le groupe n'est pas réellement joint et
        // resterait bloqué. On purge le storage (forgetGroup purge désormais mémoire + storage)
        // puis on redemande un Welcome propre, honoré sans collision de storage.
        const target = terminalId || (groupId ?? '');
        noMatchKpFailures.delete(target);
        if (target) {
          log(
            `[WELCOME] GroupAlreadyExists pour ${target.slice(0, 8)}… - forget storage + re-Welcome`
          );
          mlsService.forgetGroup(target);
          statePersister.persistNow();
          await requestReAdd(target, deps, recoveryTimers);
        }
      } else if (err.includes('NoMatchingKeyPackage')) {
        // Nos KeyPackages publiés ne correspondent plus à nos clés privées locales :
        // l'invitant nous ré-ajoute avec un KeyPackage qu'on ne peut pas honorer.
        const target = terminalId || (groupId ?? '');
        const failures = (noMatchKpFailures.get(target) ?? 0) + 1;
        noMatchKpFailures.set(target, failures);

        if (failures > MAX_NOMATCH_KP_RETRIES) {
          // Ré-ajout durablement en échec → recovery complète plutôt que re-boucler.
          log(
            `[WELCOME] NoMatchingKeyPackage #${failures} pour ${target.slice(0, 8)}… - escalade requestReAdd`
          );
          noMatchKpFailures.delete(target);
          if (target) await requestReAdd(target, deps, recoveryTimers);
        } else {
          // 1ʳᵉ détection : republier un matériel de clé frais pour que le prochain
          // ré-ajout de l'invitant utilise un KeyPackage qu'on peut honorer.
          // republishKeyMaterial débounce lui-même les appels rapprochés.
          if (failures === 1) {
            log(
              `[WELCOME] NoMatchingKeyPackage pour ${target.slice(0, 8)}… - republication KeyPackages + welcome_request`
            );
            await mlsService.republishKeyMaterial(deps.pin).catch(() => {});
          } else {
            log(
              `[WELCOME] NoMatchingKeyPackage #${failures} pour ${target.slice(0, 8)}… - welcome_request`
            );
          }
          if (target) await mlsService.sendWelcomeRequest(target).catch(() => {});
        }
      } else if (err.includes('CannotDecryptOwnMessage')) {
        // Welcome destiné à un autre device - ignorer
        log(`[WELCOME] CannotDecryptOwnMessage pour ${groupId?.slice(0, 8)}… - ACK silencieux`);
      } else {
        log(`[WELCOME] Erreur traitement ${groupId?.slice(0, 8)}…: ${err.slice(0, 150)}`);
      }
    }
  });

  return true; // Toujours ACKé
}

interface UnknownGroupArgs {
  sender: string;
  content: Uint8Array;
  groupId: string;
  deps: MessageHandlerDeps;
  pendingBuffer: Map<string, { msgs: PendingMsg[]; timer: ReturnType<typeof setTimeout> }>;
  recoveryTimers: Map<string, ReturnType<typeof setTimeout>>;
}

/**
 * Bufferise un commit arrivé pour un groupe inconnu (Welcome pas encore reçu).
 *
 * Envoie un `welcome_request` au premier message, arme un timer de 10s.
 * Au timeout : ACKe le buffer et demande un re-add.
 * Retourne `false` pour garder le message dans la queue serveur (replay possible).
 */
async function handleUnknownGroup({
  sender,
  content,
  groupId,
  deps,
  pendingBuffer,
  recoveryTimers,
}: UnknownGroupArgs): Promise<boolean> {
  const { mlsService, log } = deps;

  // Guard : groupe mort dont on connaît le successeur - le message ne peut pas être
  // déchiffré (mauvaise epoch). Évite un welcome_request inutile qui génère un doublon
  // de conversation sur les autres devices et déclenche une cascade de recovery erronée.
  let buf = pendingBuffer.get(groupId);
  if (!buf) {
    const meta = await mlsService.getGroupMeta(groupId).catch(() => null);
    if (meta?.successorId) {
      const localGroups = mlsService.getLocalGroups();
      if (localGroups.includes(meta.successorId)) {
        log(
          `[BUFFER] Msg groupe mort ${groupId.slice(0, 8)}… - successeur ${meta.successorId.slice(0, 8)}… en WASM - ACK silencieux`
        );
      } else {
        log(
          `[BUFFER] Msg groupe mort ${groupId.slice(0, 8)}… - requestReAdd vers successeur ${meta.successorId.slice(0, 8)}…`
        );
        await requestReAdd(meta.successorId, deps, recoveryTimers);
      }
      return true; // ACK : le message d'un groupe mort ne peut pas être déchiffré
    }

    await mlsService.sendWelcomeRequest(groupId).catch(() => {});
    const timer = setTimeout(async () => {
      pendingBuffer.delete(groupId);
      if (!mlsService.getLocalGroups().includes(groupId)) {
        log(`[BUFFER] 10s écoulées pour ${groupId.slice(0, 8)}… - requestReAdd`);
        await requestReAdd(groupId, deps, recoveryTimers);
      }
    }, 10_000);
    buf = { msgs: [], timer };
    pendingBuffer.set(groupId, buf);
    log(`[BUFFER] welcome_request envoyé pour groupe inconnu ${groupId.slice(0, 8)}…`);
  }

  if (buf.msgs.length < 20) buf.msgs.push({ sender, content });

  return false; // Garder en queue pour replay quand le Welcome arrive
}

interface KnownGroupArgs {
  sender: string;
  content: Uint8Array;
  groupId: string;
  isCommit: boolean | undefined;
  deliveryMeta: IncomingDeliveryMeta | undefined;
  deps: MessageHandlerDeps;
  statePersister: ReturnType<typeof createMlsStatePersister>;
  onOutOfSync: (groupId: string) => Promise<void>;
  /** Timestamp (ms) du 1er gap d'epoch non résolu par groupe (escalade epoch-gap). */
  epochGapSince: Map<string, number>;
}

/**
 * Déchiffre et dispatche un message pour un groupe connu.
 *
 * Toujours ACKé : si le déchiffrement échoue, on demande un re-add
 * plutôt que de garder le message en queue indéfiniment.
 */
async function handleKnownGroup({
  sender,
  content,
  groupId,
  isCommit,
  deliveryMeta,
  deps,
  statePersister,
  onOutOfSync,
  epochGapSince,
}: KnownGroupArgs): Promise<boolean> {
  const {
    mlsService,
    conversations,
    messageReactions,
    storage,
    pin,
    addMessageToChat,
    onCallSignal,
    log,
  } = deps;

  const convoKey = groupId;
  const convo = conversations.get(convoKey);
  if (!convo) {
    log(`[MLS] Message pour conversation absente ${convoKey.slice(0, 8)}… - retry après restore`);
    return false;
  }

  try {
    resetWasmDuplicateDeliveryFlag();
    const decrypted = await mlsService.processIncomingMessage(groupId, content);

    // Persister : immédiat pour les commits (epoch avancée), différé pour les app msgs
    if (isCommit) {
      // Seul un commit avance réellement l'epoch et résorbe donc un gap → on annule l'escalade.
      // Un message applicatif qui se déchiffre (typiquement un pair resté sur la MEME branche
      // stale qu'un device forké) ne rattrape PAS la branche divergente : remettre le timer à
      // zéro ici empêcherait à jamais l'escalade forget+re-welcome qui répare le fork (H7).
      epochGapSince.delete(groupId);
      statePersister.persistNow();
    } else {
      statePersister.scheduleDeferred();
    }

    if (decrypted === null) {
      // null peut être un commit structurel (add/remove) ou un duplicate légitime
      if (consumeWasmDuplicateDeliveryFlag()) {
        log(`[MLS] Duplicate pour ${convoKey.slice(0, 8)}… - ACK silencieux`);
      } else {
        log(`[MLS] Commit structurel pour ${convoKey.slice(0, 8)}… - sans payload applicatif`);
      }
      return true;
    }

    const msg = decodeAppMessage(decrypted);
    if (!msg) {
      log(`[MLS] Payload non décodable pour ${convoKey.slice(0, 8)}… - ACK`);
      return true;
    }

    if (msg.text || msg.reply || msg.media) {
      const envelope = appMsgToEnvelope(msg, deliveryMeta?.queuedCreatedAt);
      if (envelope) {
        const stableId =
          normalizeMessageId(msg.messageId) ?? normalizeMessageId(deliveryMeta?.queuedMessageId);
        if (stableId) envelope.options.messageId = stableId;
        log(`[MLS] Message déchiffré pour ${convoKey.slice(0, 8)}… → addMessageToChat`);
        await addMessageToChat(sender, envelope.content, convoKey, {
          ...envelope.options,
          serverTimestamp: deliveryMeta?.queuedCreatedAt,
        });
      } else {
        log(`[MLS] Enveloppe vide pour ${convoKey.slice(0, 8)}… - rien à afficher`);
      }
    } else if (msg.reaction) {
      const msgId = msg.reaction.messageId ?? '';
      const emoji = msg.reaction.emoji ?? '';
      const reactions = messageReactions.get(msgId) || [];
      const updated = addMessageReaction(reactions, sender, emoji);
      if (updated) {
        messageReactions.set(msgId, updated);
        const c = conversations.get(convoKey);
        if (c) {
          const idx = c.messages.findIndex((m) => m.id === msgId);
          if (idx !== -1) {
            const next = [...c.messages];
            next[idx] = { ...next[idx], reactions: updated };
            conversations.set(convoKey, { ...c, messages: next });
            if (storage) {
              const t = next[idx];
              await storage
                .saveMessage(
                  {
                    id: t.id,
                    conversationId: convoKey,
                    senderId: t.senderId,
                    content: t.content,
                    timestamp: t.timestamp.getTime(),
                    readBy: t.readBy,
                    reactions: updated,
                  },
                  pin
                )
                .catch(() => {});
            }
          }
        }
      }
    } else if (msg.call) {
      onCallSignal?.(sender, groupId, msg.call);
    } else if (msg.system) {
      const event = msg.system.event ?? '';
      let data: any = {};
      try {
        data = msg.system.data ? JSON.parse(msg.system.data) : {};
      } catch {
        /* noop */
      }
      await handleSystemEvent(event, data, {
        ...deps,
        convo: conversations.get(convoKey) ?? convo,
        convoKey,
        senderNorm: sender,
        persistMlsStateNow: () => statePersister.persistNow(),
        deliveryMeta,
      });
    }

    return true;
  } catch (e) {
    const err = String(e);
    const kind = classifyIncomingDecryptError(e);

    if (kind === 'own-message') return true;
    if (kind === 'oom') {
      deps.onMlsFatalError?.('oom');
      return true;
    }
    if (kind === 'epoch-gap') {
      // Tauri : message bufferisé en SQLite (`GAP_QUEUED`). Web WASM : erreur directe
      // `epoch gap [msg_epoch=…, group_epoch=…]`. Un gap se résorbe normalement quand
      // les commits manqués arrivent. Mais sur un groupe qu'on détient déjà,
      // si les commits ne reviennent jamais (purgés serveur), le groupe reste figé en
      // retard et tous les messages futurs échouent en boucle - le SYNC_WATCHDOG ne le
      // couvre pas (il ne vise que les groupes absents du WASM). Au-delà du seuil, on
      // oublie l'état forké et on redemande un Welcome : comme le groupe n'est plus
      // local, le re-Welcome est honoré (et non ignoré comme idempotent) → on rejoint
      // à l'epoch courante. L'historique de messages, lui, est rebackfillé par le bundle.
      const now = Date.now();
      const since = epochGapSince.get(groupId);
      if (since === undefined) {
        epochGapSince.set(groupId, now);
      } else if (now - since > EPOCH_GAP_ESCALATION_MS) {
        epochGapSince.delete(groupId);
        log(
          `[GAP] ${groupId.slice(0, 8)}… figé en retard >${EPOCH_GAP_ESCALATION_MS / 1000}s - forget + welcome_request`
        );
        mlsService.forgetGroup(groupId);
        statePersister.persistNow();
        await onOutOfSync(groupId); // forget effectué → re-Welcome honoré (groupe non local)
      }
      return true;
    }

    // Livraison en double (publish temps-réel + queue/FCM) : le message a déjà été
    // déchiffré et son secret de ratchet consommé/supprimé. Le groupe est sain -
    // surtout ne PAS déclencher onOutOfSync (qui détruirait une membership valide
    // par une recovery parasite). On ACK simplement le doublon.
    if (kind === 'secret-reuse') {
      log(`[MLS] SecretReuseError (doublon) pour ${convoKey.slice(0, 8)}… - ACK silencieux`);
      return true;
    }

    // Tout autre échec (`wrong-epoch`, `unknown`) → hors-sync → requestReAdd + ACK
    log(`[MLS] Erreur déchiffrement ${convoKey.slice(0, 8)}…: ${err.slice(0, 100)} → re-add`);
    await onOutOfSync(groupId);
    return true;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Crée ou met à jour la conversation locale après un Welcome.
 * Détermine si c'est un DM (isGroup=false ou nom "alice::bob") ou un groupe.
 */
async function upsertConversation(
  joinedGroupId: string,
  gData: { name?: string; isGroup?: boolean } | null,
  senderNorm: string,
  userId: string,
  deps: MessageHandlerDeps
): Promise<void> {
  const { conversations, saveConversation } = deps;

  const groupName = gData?.name ?? senderNorm;
  const isGroupFromApi: boolean | null = typeof gData?.isGroup === 'boolean' ? gData.isGroup : null;

  const peerFromName = parseDirectPeerFromName(groupName, userId);

  let isDirect = false;
  let directPeerId = '';

  if (isGroupFromApi === false) {
    isDirect = true;
    const candidate = peerFromName ?? (senderNorm !== userId ? senderNorm : '');
    directPeerId = candidate;
  } else if (isGroupFromApi === null && peerFromName) {
    isDirect = true;
    directPeerId = peerFromName;
  }

  // Garde contre DM avec soi-même (métadonnées manquantes + sender = soi)
  if (isDirect && (!directPeerId || directPeerId === userId)) {
    const migrated = conversations.get(joinedGroupId);
    const existing = migrated?.directPeerId ?? migrated?.contactName ?? '';
    if (existing && existing !== userId) {
      directPeerId = existing;
    } else {
      isDirect = false;
      directPeerId = '';
    }
  }

  // Trouver une conversation existante correspondant à ce DM
  let newConvoKey = joinedGroupId;
  let matchedExisting = false;

  if (isDirect) {
    const existingDirect = Array.from(conversations.entries()).find(([, c]) => {
      if ((c.conversationType ?? 'group') !== 'direct') return false;
      return (c.directPeerId ?? c.contactName).toLowerCase() === directPeerId;
    });
    if (existingDirect) {
      newConvoKey = existingDirect[0];
      matchedExisting = true;
    }
  } else if (conversations.has(joinedGroupId)) {
    matchedExisting = true;
  }

  const displayName = isDirect ? directPeerId : groupName;

  if (matchedExisting) {
    const existing = conversations.get(newConvoKey)!;
    // Re-join via Welcome : on est de nouveau réellement membre, donc on lève toute marque
    // `deletedRemotely` posée par la discovery (groupe supprimé/exclu OU faux positif d'une race
    // de snapshot). Sans ça la conversation resterait verrouillée avec sa bannière " supprimée "
    // alors qu'on vient d'y être ré-ajouté (règle : re-add => même conversation, active).
    const updated = {
      ...existing,
      id: joinedGroupId,
      name: displayName,
      lifecycle: 'active' as const,
    };
    if (newConvoKey !== joinedGroupId) {
      // Prédécesseur → successeur : on change de groupId (ex. reboot MLS).
      conversations.delete(newConvoKey);
      newConvoKey = joinedGroupId;

      // Persister les messages en mémoire dans l'IndexedDB du successeur.
      // Sans ça, loadHistoryForConversation (qui lit depuis l'IndexedDB du nouveau groupId)
      // écrase la liste en mémoire avec un tableau vide, et les messages disparaissent jusqu'au
      // prochain login où mergeDirectConversationDuplicates les migre proprement.
      const msgs = existing.messages ?? [];
      if (deps.storage && msgs.length > 0) {
        const toSave = msgs
          .filter((m) => m.id && m.status !== 'sending')
          .map((m) => ({
            id: m.id,
            conversationId: joinedGroupId,
            senderId: m.senderId,
            content: m.content,
            timestamp: m.timestamp instanceof Date ? m.timestamp.getTime() : Number(m.timestamp),
            readBy: m.readBy,
            reactions: m.reactions,
            isDeleted: m.isDeleted,
            isEdited: m.isEdited,
            readAt: m.readAt,
            serverTimestamp: m.serverTimestamp,
          }));
        if (toSave.length > 0) {
          await deps.storage.saveMessages(toSave, deps.pin).catch(() => {});
          deps.log(
            `[WELCOME] ${toSave.length} message(s) de ${existing.id.slice(0, 8)}… persistés dans ${joinedGroupId.slice(0, 8)}… (successeur)`
          );
        }
      }
    }
    conversations.set(newConvoKey, updated);
  } else {
    conversations.set(newConvoKey, {
      id: joinedGroupId,
      contactName: displayName,
      name: displayName,
      messages: [],
      lifecycle: 'active',
      mlsStateHex: null,
      conversationType: isDirect ? 'direct' : 'group',
      ...(isDirect ? { directPeerId } : {}),
    });
  }

  await saveConversation(newConvoKey).catch(() => {});

  // Re-ajout effectif : on leve un eventuel dismiss per-user cote serveur pour que la conversation
  // revienne aussi sur les AUTRES appareils de l'utilisateur (regle re-add). Best-effort.
  void deps.mlsService.undismissGroup(joinedGroupId).catch(() => {});
}
