import { parseDirectPeerFromName } from '$lib/utils/chat/conversations';
import { decodeAppMessage } from '$lib/proto/codec';
import { appMsgToEnvelope, normalizeMessageId } from '$lib/utils/chat/messageUtils';
import { addMessageReaction } from '$lib/utils/chat/messageReactions';
import { requestReAdd, cancelReAdd } from '$lib/utils/chat/recovery';
import { handleSystemEvent } from './systemMessageHandler';
import { handleChannelEvent } from './channelEventHandler';
import {
  installWasmDuplicateDeliveryLogInterceptor,
  resetWasmDuplicateDeliveryFlag,
  consumeWasmDuplicateDeliveryFlag,
} from '../wasmLogShim';
import { createMlsStatePersister } from '../mlsStatePersister';
import type { MessageHandlerDeps } from './deps';
export type { MessageHandlerDeps } from './deps';

/** Message en attente de Welcome dans le buffer court. */
type PendingMsg = { sender: string; content: Uint8Array };

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
 * 3. L'état recovery (timers) est en mémoire seulement — reset à chaque session.
 */
export function setupMessageHandler(deps: MessageHandlerDeps): void {
  const { mlsService, pin, userId, log } = deps;

  installWasmDuplicateDeliveryLogInterceptor();

  const statePersister = createMlsStatePersister({ mlsService, pin, userId, log });

  // Flush immédiat quand l'app passe en arrière-plan (FCM Android)
  if (typeof document !== 'undefined') {
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) void statePersister.flush();
      },
      { passive: true }
    );
  }

  if (mlsService.setBulkIngestHooks) {
    mlsService.setBulkIngestHooks(
      () => statePersister.onBulkIngestStart(),
      () => statePersister.onBulkIngestEnd()
    );
  }

  // Buffer court : commits arrivant avant leur Welcome (max 10s d'attente)
  const pendingBuffer = new Map<
    string,
    { msgs: PendingMsg[]; timer: ReturnType<typeof setTimeout> }
  >();

  // Timers de recovery par groupe (deduplique les requestReAdd dans une session)
  const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Callback partagé pour tout cas "hors-sync"
  const onOutOfSync = async (groupId: string) => {
    log(`[PIPELINE] Hors-sync pour ${groupId.slice(0, 8)}… — requestReAdd`);
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

      if (!groupId) return true; // ACK sans groupe — frame de contrôle

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
 * Traite un message Welcome — pour un groupe connu ou inconnu.
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
    loadHistoryForConversation,
    historyBaseUrl,
    onGroupReady,
    log,
    batchAddMessages,
    addMessageToChat,
  } = deps;

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
    deps.cancelGroupRecovery?.(joinedGroupId); // annule aussi le timer armé par onGroupMissing

    // Persister immédiatement après Welcome (epoch initialisée)
    statePersister.persistNow();

    // Enregistrement côté serveur (idempotent — safety net si l'invitant n'a pas encore
    // appelé registerMember pour cet userId, ex. race dans inviteMembers/reboot).
    await mlsService.registerMember(joinedGroupId, userId).catch(() => {});
    // Note : updateInvitationStatus(active) supprimé — le serveur le fait déjà dans
    // sendWelcome (messaging.service.ts) avant même que le client reçoive le message.

    // Récupérer les métadonnées du groupe pour créer/mettre à jour la conversation
    const gData = await fetchGroupMeta(historyBaseUrl, joinedGroupId);
    await upsertConversation(joinedGroupId, gData, sender, userId, deps);

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

    // Historique en arrière-plan
    await loadHistoryForConversation(joinedGroupId, joinedGroupId).catch(() => {});

    // Notifier que ce groupe est prêt (déclenche processDeviceInvitations)
    onGroupReady?.(joinedGroupId);
    log(`[WELCOME] Groupe ${joinedGroupId.slice(0, 8)}… prêt`);
  } catch (e) {
    const err = String(e);
    if (err.includes('GroupAlreadyExists')) {
      // Idempotent — on a déjà ce groupe, marquer prêt si besoin
      if (groupId) {
        const convo = deps.conversations.get(groupId);
        if (convo && !convo.isReady) {
          deps.conversations.set(groupId, { ...convo, isReady: true });
          await saveConversation(groupId).catch(() => {});
        }
        onGroupReady?.(groupId);
      }
      log(`[WELCOME] GroupAlreadyExists pour ${groupId?.slice(0, 8)}… — noop`);
    } else if (err.includes('NoMatchingKeyPackage')) {
      // Clé consommée — demander une nouvelle invitation
      log(`[WELCOME] NoMatchingKeyPackage pour ${groupId?.slice(0, 8)}… — welcome_request`);
      if (groupId) await mlsService.sendWelcomeRequest(groupId).catch(() => {});
    } else if (err.includes('CannotDecryptOwnMessage')) {
      // Welcome destiné à un autre device — ignorer
      log(`[WELCOME] CannotDecryptOwnMessage pour ${groupId?.slice(0, 8)}… — ACK silencieux`);
    } else {
      log(`[WELCOME] Erreur traitement ${groupId?.slice(0, 8)}…: ${err.slice(0, 150)}`);
    }
  }

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

  let buf = pendingBuffer.get(groupId);
  if (!buf) {
    await mlsService.sendWelcomeRequest(groupId).catch(() => {});
    const timer = setTimeout(async () => {
      pendingBuffer.delete(groupId);
      if (!mlsService.getLocalGroups().includes(groupId)) {
        log(`[BUFFER] 10s écoulées pour ${groupId.slice(0, 8)}… — requestReAdd`);
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
  deliveryMeta: any;
  deps: MessageHandlerDeps;
  statePersister: ReturnType<typeof createMlsStatePersister>;
  onOutOfSync: (groupId: string) => Promise<void>;
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
  if (!convo) return true; // ACK — conversation inconnue

  try {
    resetWasmDuplicateDeliveryFlag();
    const decrypted = await mlsService.processIncomingMessage(groupId, content);

    // Persister : immédiat pour les commits (epoch avancée), différé pour les app msgs
    if (isCommit) {
      statePersister.persistNow();
    } else {
      statePersister.scheduleDeferred();
    }

    if (decrypted === null) {
      // null peut être un commit structurel (add/remove) ou un duplicate légitime
      if (consumeWasmDuplicateDeliveryFlag()) {
        log(`[MLS] Duplicate pour ${convoKey.slice(0, 8)}… — ACK silencieux`);
      }
      // Commit structurel sans payload applicatif — ok
      return true;
    }

    const msg = decodeAppMessage(decrypted);
    if (!msg) return true;

    if (msg.text || msg.reply || msg.media) {
      const envelope = appMsgToEnvelope(msg, deliveryMeta?.queuedCreatedAt);
      if (envelope) {
        const stableId =
          normalizeMessageId(msg.messageId) ?? normalizeMessageId(deliveryMeta?.queuedMessageId);
        if (stableId) envelope.options.messageId = stableId;
        await addMessageToChat(sender, envelope.content, convoKey, {
          ...envelope.options,
          serverTimestamp: deliveryMeta?.queuedCreatedAt,
        });
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

    if (err.includes('CannotDecryptOwnMessage')) return true;
    if (err.includes('out of memory') || err.includes('unreachable')) {
      deps.onMlsFatalError?.('oom');
      return true;
    }
    if (err.includes('GAP_QUEUED')) return true; // Tauri : buffered en SQLite

    // Tout autre échec → hors-sync → requestReAdd + ACK
    log(`[MLS] Erreur déchiffrement ${convoKey.slice(0, 8)}…: ${err.slice(0, 100)} → re-add`);
    await onOutOfSync(groupId);
    return true;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Récupère les métadonnées d'un groupe depuis l'API REST. */
async function fetchGroupMeta(
  historyBaseUrl: string,
  groupId: string
): Promise<{ name?: string; isGroup?: boolean } | null> {
  try {
    const { getToken } = await import('$lib/stores/auth');
    const token = await getToken().catch(() => null);
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const r = await fetch(`${historyBaseUrl}/api/mls/groups/${groupId}`, { headers });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

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
    const updated = { ...existing, id: joinedGroupId, name: displayName, isReady: true };
    if (newConvoKey !== joinedGroupId) {
      conversations.delete(newConvoKey);
      newConvoKey = joinedGroupId;
    }
    conversations.set(newConvoKey, updated);
  } else {
    conversations.set(newConvoKey, {
      id: joinedGroupId,
      contactName: displayName,
      name: displayName,
      messages: [],
      isReady: true,
      mlsStateHex: null,
      conversationType: isDirect ? 'direct' : 'group',
      ...(isDirect ? { directPeerId } : {}),
    });
  }

  await saveConversation(newConvoKey).catch(() => {});
}
