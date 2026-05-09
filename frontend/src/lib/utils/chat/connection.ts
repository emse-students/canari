import type { IMlsService } from '$lib/mlsService';
import type { IStorage } from '$lib/db';
import type { ChatMessage, Conversation } from '$lib/types';
import { saveMlsState } from '$lib/utils/hex';
import type { SvelteMap } from 'svelte/reactivity';
import type { MessageReaction } from '$lib/types';
import { decodeAppMessage, encodeAppMessage, mkSystem, MediaKind } from '$lib/proto/codec';
import { serializeEnvelope, mkTextEnvelope, mkMediaEnvelope } from '$lib/envelope';
import { channelKeyManager } from '$lib/crypto/ChannelKeyVault';
import { ChannelService } from '$lib/services/ChannelService';

function bytesToHex(bytes?: Uint8Array | null): string {
  if (!bytes || bytes.length === 0) return '';
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function mediaKindToType(kind?: number | null): 'image' | 'video' | 'audio' | 'file' {
  switch (kind) {
    case MediaKind.MEDIA_IMAGE:
      return 'image';
    case MediaKind.MEDIA_VIDEO:
      return 'video';
    case MediaKind.MEDIA_AUDIO:
      return 'audio';
    default:
      return 'file';
  }
}

interface MessageHandlerDeps {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  pin: string;
  historyBaseUrl: string;
  conversations: SvelteMap<string, Conversation>;
  messageReactions: SvelteMap<string, MessageReaction[]>;
  selectedContact: string | null;
  setSelectedContact: (value: string | null) => void;
  saveConversation: (contactName: string) => Promise<void>;
  addMessageToChat: (
    senderId: string,
    content: string,
    contactName: string,
    replyTo?: ChatMessage['replyTo'],
    isSystem?: boolean,
    messageId?: string,
    timestamp?: Date
  ) => Promise<void>;
  addSystemMessage: (content: string, contactName: string) => Promise<void>;
  loadHistoryForConversation: (contactName: string, groupId: string) => Promise<void>;
  onChannelMemberJoined?: (event: {
    channelId: string;
    channelName?: string;
    workspaceId?: string;
    workspaceSlug?: string;
    workspaceName?: string;
    visibility?: 'public' | 'private';
    roleName?: string;
    joinedBy?: string;
  }) => void;
  onChannelMemberKicked?: (event: {
    channelId: string;
    channelName?: string;
    workspaceId?: string;
    kickedBy?: string;
  }) => void;
  onChannelUpdated?: (event: {
    channelId: string;
    name?: string;
    workspaceId?: string;
    imageMediaId?: string;
  }) => void;
  onChannelDeleted?: (event: { channelId: string; workspaceId?: string }) => void;
  onWorkspaceUpdated?: (event: { workspaceId: string; imageMediaId?: string }) => void;
  onReadReceiptReceived?: (event: {
    conversationKey: string;
    senderId: string;
    messageIds: string[];
  }) => void;
  onCallSignal?: (senderId: string, callMsg: any) => void;
  log: (msg: string) => void;
}

// ─── Multi-tab coordination ─────────────────────────────────────────────
// Only one browser tab should hold the WebSocket connection and run MLS
// operations. Other tabs run in read-only mode and receive UI updates via
// BroadcastChannel. This prevents two tabs from advancing the same MLS
// ratchet concurrently (which would cause WrongEpoch / AeadError).

const TAB_ID = crypto.randomUUID();
let isTabLeader = false;
let tabChannel: BroadcastChannel | null = null;

/**
 * Returns true if this tab is the active MLS leader (holds the WebSocket).
 */
export function getIsTabLeader(): boolean {
  return isTabLeader;
}

const LEADER_KEY = 'canari_tab_leader';
const HEARTBEAT_KEY = 'canari_tab_leader_heartbeat';
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Async leader election using localStorage heartbeat.
 * First tab claims leadership; subsequent tabs become followers.
 * Stale leader (>5s without heartbeat) is automatically replaced.
 */
export async function initTabLeadershipAsync(log: (msg: string) => void): Promise<boolean> {
  // BroadcastChannel not available (e.g. Tauri desktop) — always leader.
  if (typeof BroadcastChannel === 'undefined') {
    isTabLeader = true;
    return true;
  }

  if (!tabChannel) {
    tabChannel = new BroadcastChannel('canari-mls-tab');
    tabChannel.addEventListener('message', (ev: MessageEvent) => {
      if (ev.data?.type === 'leader_closing' && !isTabLeader) {
        // Leader is closing — try to promote
        isTabLeader = true;
        localStorage.setItem(LEADER_KEY, TAB_ID);
        localStorage.setItem(HEARTBEAT_KEY, String(Date.now()));
        startHeartbeat();
        log('[TAB] Ancien leader fermé — promotion en leader.');
      }
    });
  }

  const now = Date.now();
  const lastHeartbeat = parseInt(localStorage.getItem(HEARTBEAT_KEY) ?? '0', 10);
  const currentLeader = localStorage.getItem(LEADER_KEY);

  // Claim if no leader or heartbeat stale (>5s)
  if (!currentLeader || now - lastHeartbeat > 5000) {
    localStorage.setItem(LEADER_KEY, TAB_ID);
    localStorage.setItem(HEARTBEAT_KEY, String(now));
    isTabLeader = true;
    startHeartbeat();
    log('[TAB] Leadership acquise.');
  } else if (currentLeader === TAB_ID) {
    isTabLeader = true;
    startHeartbeat();
  } else {
    isTabLeader = false;
    log('[TAB] Autre onglet actif — mode lecture seule (pas de WebSocket).');
  }

  // Notify other tabs when this tab closes
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      if (isTabLeader) {
        tabChannel?.postMessage({ type: 'leader_closing', tabId: TAB_ID });
        if (localStorage.getItem(LEADER_KEY) === TAB_ID) {
          localStorage.removeItem(LEADER_KEY);
          localStorage.removeItem(HEARTBEAT_KEY);
        }
      }
      if (heartbeatInterval) clearInterval(heartbeatInterval);
    });
  }

  return isTabLeader;
}

function startHeartbeat(): void {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (!isTabLeader) {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      return;
    }
    localStorage.setItem(HEARTBEAT_KEY, String(Date.now()));
  }, 2000);
}

/**
 * Configure le callback pour traiter les messages entrants MLS.
 * Gère les messages de contrôle (renommage, ajout/retrait membre, suppression groupe),
 * les réactions, les réponses et les messages texte standard.
 */
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
    addMessageToChat,
    addSystemMessage,
    loadHistoryForConversation,
    onChannelMemberJoined,
    onChannelMemberKicked,
    onChannelUpdated,
    onChannelDeleted,
    onWorkspaceUpdated,
    onReadReceiptReceived,
    onCallSignal,
    log,
  } = deps;

  // Read selectedContact lazily from deps to avoid stale closure —
  // the value captured at setup time would never update.
  const getSelectedContact = () => deps.selectedContact;

  // Compteur d'échecs MLS par conversation — détection des groupes fantômes
  const groupMlsFailures = new Map<string, number>();
  const PHANTOM_THRESHOLD = 3;

  // Compteur des retours `null` sur messages applicatifs (non-commit).
  // Si cela se répète, l'état local est probablement divergent même sans exception
  // (ex: SenderDataDecryption traité côté Rust comme message non-applicable).
  const groupNullAppFailures = new Map<string, number>();
  const NULL_APP_THRESHOLD = 1;

  // Groups for which an epoch recovery has already been triggered
  // (avoids spamming reinvite_request on a burst of future-epoch messages).
  const epochRecoveryGroups = new Set<string>();

  // Buffer pour les messages (commits) qui arrivent AVANT leur Welcome.
  // Clé = groupId, Valeur = messages en attente de replay.
  const pendingGroupMessages = new Map<string, Array<{ sender: string; content: Uint8Array }>>();
  const BUFFER_MAX_PER_GROUP = 50;

  if ('onChannelEvent' in mlsService) {
    (mlsService as any).onChannelEvent = async (event: any) => {
      log(`[Channel Event] ${event.type}`);
      if (event.type === 'channel.member.joined') {
        const data = event.data || {};
        onChannelMemberJoined?.({
          channelId: String(data.channelId || ''),
          channelName: data.channelName,
          workspaceId: data.workspaceId,
          workspaceSlug: data.workspaceSlug,
          workspaceName: data.workspaceName,
          visibility: data.visibility,
          roleName: data.roleName,
          joinedBy: data.joinedBy,
        });
        return;
      }

      if (event.type === 'channel.member.kicked') {
        const data = event.data || {};
        onChannelMemberKicked?.({
          channelId: String(data.channelId || ''),
          channelName: data.channelName,
          workspaceId: data.workspaceId,
          kickedBy: data.kickedBy,
        });
        return;
      }

      if (event.type === 'channel.updated') {
        const data = event.data || {};
        onChannelUpdated?.({
          channelId: String(data.channelId || ''),
          name: data.name,
          workspaceId: data.workspaceId,
          imageMediaId: data.imageMediaId,
        });
        return;
      }

      if (event.type === 'workspace.updated') {
        const data = event.data || {};
        onWorkspaceUpdated?.({
          workspaceId: String(data.workspaceId || ''),
          imageMediaId: data.imageMediaId,
        });
        return;
      }

      if (event.type === 'channel.deleted') {
        const data = event.data || {};
        onChannelDeleted?.({
          channelId: String(data.channelId || ''),
          workspaceId: data.workspaceId,
        });
        return;
      }

      if (event.type === 'channel.key.rotated') {
        const data = event.data || {};
        const channelId = String(data.channelId || '');
        const newEpochBaseKey = data.newEpochBaseKey;
        const keyVersion = data.keyVersion;
        if (channelId && newEpochBaseKey && keyVersion !== undefined) {
          try {
            if (!Number.isInteger(keyVersion) || keyVersion < 0) {
              throw new Error(`Invalid keyVersion: ${keyVersion}`);
            }
            if (
              typeof newEpochBaseKey !== 'string' ||
              !/^[A-Za-z0-9+/]*={0,2}$/.test(newEpochBaseKey)
            ) {
              throw new Error('Invalid base64 format for epoch key');
            }
            const vault = channelKeyManager.getVault(channelId);
            const rawKeyMat = new Uint8Array(
              atob(newEpochBaseKey)
                .split('')
                .map((c) => c.charCodeAt(0))
            );
            if (rawKeyMat.length < 32) {
              throw new Error(`Key material too short: ${rawKeyMat.length} bytes`);
            }
            await vault.rotateKey(keyVersion, rawKeyMat);
            log(`[Key Rotation] Epoch ${keyVersion} stored for Channel ${channelId}`);
          } catch (e) {
            log(`[ERROR] Key rotation failed for channel ${channelId}: ${e}`);
            console.error('[Key Rotation] failed for channel', channelId, e);
          }
        }
        return;
      }

      if (event.type === 'epoch_rejected') {
        const data = event.data || {};
        const groupId = String(data.groupId || '');
        const currentEpoch = Number(data.currentEpoch || 0);
        log(
          `[EPOCH] Commit rejeté pour groupe ${groupId} (epoch serveur: ${currentEpoch}) — oubli MLS + reinvite_request`
        );
        if (groupId) {
          epochRecoveryGroups.add(groupId);
          mlsService.forgetGroup(groupId, currentEpoch);
          const stBytes = await mlsService.saveState(pin);
          await saveMlsState(userId, stBytes);
          await mlsService.sendReinviteRequest(groupId);
        }
        return;
      }

      if (event.type === 'channel.message.created') {
        const data = event.data;
        const channelId = `channel_${data.channelId}`;
        const sender = data.senderId;

        // We now rely on the backend echo for our own messages in channels
        // Check if we have this channel in our conversations list
        // Since the map is keyed by id (= groupId), a direct has() check is sufficient.
        const convoKey: string | undefined = conversations.has(channelId) ? channelId : undefined;

        if (convoKey) {
          let content = '[Message chiffré]';
          let appMessageId: string | undefined;
          try {
            if (data.ciphertext) {
              let bytes: Uint8Array;

              if (data.nonce && data.keyVersion !== undefined) {
                // Genuine AES-GCM encryption with rotated keys
                bytes = await channelKeyManager.decryptMessage(
                  data.channelId,
                  data.ciphertext,
                  data.nonce,
                  data.keyVersion
                );
              } else {
                // Fallback to legacy mock base64 for old messages
                const binStr = atob(data.ciphertext);
                bytes = new Uint8Array(binStr.length);
                for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
              }

              const msg = decodeAppMessage(bytes);
              appMessageId = msg?.messageId || undefined;
              if (msg?.text) {
                content = serializeEnvelope(mkTextEnvelope(msg.text.content ?? ''));
              } else if (msg?.reply) {
                const replyTo = msg.reply.replyTo
                  ? {
                      id: msg.reply.replyTo.id || '',
                      senderId: msg.reply.replyTo.senderId || '',
                      content: msg.reply.replyTo.preview || '',
                    }
                  : undefined;
                content = serializeEnvelope(mkTextEnvelope(msg.reply.content ?? '', replyTo));
              }
            } else if (data.plaintext) {
              content = serializeEnvelope(mkTextEnvelope(data.plaintext));
            }
          } catch (e) {
            console.error('Failed to parse channel message:', e);
          }

          addMessageToChat(
            sender,
            content,
            convoKey,
            undefined,
            false,
            appMessageId || data.messageId || data.id,
            new Date(data.createdAt)
          ).catch((e) => console.error(e));
        } else {
          // We might want to auto-create the conversation if not found, but we skip for now
          // or add a system message log
          log(`Canal inconnu reçu: ${channelId}`);
        }
      }
    };
  }

  mlsService.onMessage(
    async (sender, content, groupId, isWelcome, ratchetTreeBytes, isCommit): Promise<boolean> => {
      log(
        `Message de ${sender} (${content.length} octets) - Grp: ${groupId} (isWelcome: ${!!isWelcome}, isCommit: ${!!isCommit})`
      );
      const senderNorm = sender.toLowerCase();

      // Find conversation by groupId — the map is now keyed by id = groupId, so O(1) lookup.
      let convoKey: string | undefined;
      if (groupId) {
        convoKey = conversations.has(groupId) ? groupId : undefined;
      }

      // Log de la décision de routage
      if (convoKey) {
        log(`[ROUTE] groupId="${groupId ?? 'N/A'}" → convoKey="${convoKey}"`);
      } else if (groupId) {
        log(
          `[ROUTE] groupId="${groupId}" inconnu — ${conversations.size} convos locales, isWelcome=${!!isWelcome}` +
            (isWelcome ? ' → nouveau groupe' : ' → message bufferisé')
        );
      } else {
        log(`[ROUTE] Pas de groupId, fallback par sender="${senderNorm}"`);
      }

      // Only fall back to sender-based routing when no groupId is provided.
      // If a groupId is present but unknown, it is likely a Welcome for a new group
      // — routing it to an existing 1-to-1 conversation would silently discard it.
      if (!convoKey && !groupId) {
        const directEntry = Array.from(conversations.entries()).find(([, convo]) => {
          if ((convo.conversationType ?? 'group') !== 'direct') return false;
          const peer = (convo.directPeerId ?? convo.contactName).toLowerCase();
          return peer === senderNorm;
        });
        if (directEntry) {
          convoKey = directEntry[0];
        }
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
          await mlsService.processWelcome(content, ratchetTreeBytes);
          const stBytes = await mlsService.saveState(pin);
          await saveMlsState(userId, stBytes);

          // registerMember et welcome_received sont idempotents côté serveur.
          // On les appelle dans TOUS les cas (reset ou première jonction) pour
          // garantir que le routing Redis (group:members:groupId) est à jour.
          try {
            await mlsService.registerMember(groupId!, userId);
          } catch {
            /* non-bloquant */
          }
          try {
            await mlsService.updateInvitationStatus(
              mlsService.getDeviceId(),
              userId,
              groupId!,
              'welcome_received'
            );
          } catch {
            /* non-bloquant */
          }

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
        } catch (welcomeErr) {
          const welcomeErrMsg = String(welcomeErr);
          // Welcome pour un autre device, dupliqué, ou "CannotDecryptOwnMessage" → ACK silencieux.
          if (
            welcomeErrMsg.includes('already') ||
            welcomeErrMsg.includes('duplicate') ||
            welcomeErrMsg.includes('exists') ||
            welcomeErrMsg.includes('CannotDecryptOwnMessage')
          ) {
            return true;
          }
          // Échec réel (OTKP mismatch, état corrompu…) → laisser en queue pour retry.
          log(`[MLS] Welcome processing failed (${welcomeErrMsg}) — kept in queue for retry`);
          return false;
        }
        return true;
      }

      // Process message for known conversation
      if (convoKey && !isWelcome) {
        const convo = conversations.get(convoKey)!;
        try {
          const decryptedBytes = await mlsService.processIncomingMessage(convo.id, content);
          log(
            `[MLS] processIncomingMessage(${convo.id}) → ${decryptedBytes ? decryptedBytes.length + ' octets déchiffrés' : 'null (commit structural ou payload vide)'}`
          );

          // Auto-save MLS state
          try {
            const stBytes = await mlsService.saveState(pin);
            await saveMlsState(userId, stBytes);
          } catch {
            // Silent fallback if autosave fails
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

            if (msg?.text) {
              await addMessageToChat(
                senderNorm,
                serializeEnvelope(mkTextEnvelope(msg.text.content ?? '')),
                convoKey,
                undefined,
                false,
                msg.messageId || undefined
              );
              return true;
            }

            if (msg?.reply) {
              const replyTo = msg.reply.replyTo
                ? {
                    id: msg.reply.replyTo.id ?? '',
                    senderId: msg.reply.replyTo.senderId ?? '',
                    content: msg.reply.replyTo.preview ?? '',
                  }
                : undefined;
              await addMessageToChat(
                senderNorm,
                serializeEnvelope(mkTextEnvelope(msg.reply.content ?? '', replyTo)),
                convoKey,
                undefined,
                false,
                msg.messageId || undefined
              );
              return true;
            }

            if (msg?.reaction) {
              const msgId = msg.reaction.messageId ?? '';
              const reactions = messageReactions.get(msgId) || [];
              const emoji = msg.reaction.emoji ?? '';
              // Déduplique l'emoji exact, puis ajoute (permet plusieurs emojis par utilisateur)
              const filtered = reactions.filter(
                (r) => !(r.userId === senderNorm && r.emoji === emoji)
              );
              filtered.push({ emoji, userId: senderNorm });
              messageReactions.set(msgId, filtered);

              // Also persist the reaction into the message's DB row
              const convo = conversations.get(convoKey);
              if (storage && convo) {
                const target = convo.messages.find((m) => m.id === msgId);
                if (target) {
                  try {
                    await storage.saveMessage(
                      {
                        id: target.id,
                        conversationId: convoKey,
                        senderId: target.senderId,
                        content: target.content,
                        timestamp: target.timestamp.getTime(),
                        readBy: target.readBy,
                        reactions: filtered,
                      },
                      pin
                    );
                  } catch {
                    // Non-blocking
                  }
                }
              }

              log(`[REACTION] ${senderNorm} a reagi avec ${msg.reaction.emoji}`);
              return true;
            }

            if (msg?.media) {
              await addMessageToChat(
                senderNorm,
                serializeEnvelope(
                  mkMediaEnvelope(
                    {
                      type: mediaKindToType(msg.media.kind),
                      mediaId: msg.media.mediaId ?? '',
                      key: bytesToHex(msg.media.key),
                      iv: bytesToHex(msg.media.iv),
                      mimeType: msg.media.mimeType ?? '',
                      size: msg.media.size ?? 0,
                      fileName: msg.media.fileName ?? undefined,
                    },
                    msg.media.caption || undefined
                  )
                ),
                convoKey,
                undefined,
                false,
                msg.messageId || undefined
              );
              return true;
            }

            if (msg?.call) {
              if (onCallSignal) {
                onCallSignal(senderNorm, msg.call);
              }
              return true;
            }

            if (msg?.system) {
              const event = msg.system.event;
              const data = msg.system.data ? JSON.parse(msg.system.data) : {};

              if (event === 'channel_key_distribution') {
                const channelId = String(data.channelId || '');
                const distributionId = String(data.distributionId || '');
                const encryptedChannelKey = String(data.encryptedChannelKey || '');
                const keyVersion = Number(data.keyVersion || 0);
                const epochKeysRaw = Array.isArray(data.epochKeys) ? data.epochKeys : [];

                const epochKeys = epochKeysRaw
                  .map((entry: any) => ({
                    keyVersion: Number(entry?.keyVersion),
                    encryptedChannelKey: String(entry?.encryptedChannelKey || ''),
                  }))
                  .filter(
                    (entry: { keyVersion: number; encryptedChannelKey: string }) =>
                      Number.isFinite(entry.keyVersion) &&
                      entry.keyVersion > 0 &&
                      !!entry.encryptedChannelKey
                  );

                const fallbackCurrent =
                  encryptedChannelKey && Number.isFinite(keyVersion) && keyVersion > 0
                    ? [{ keyVersion, encryptedChannelKey }]
                    : [];
                const keysToImport = epochKeys.length > 0 ? epochKeys : fallbackCurrent;

                if (!channelId || !distributionId || keysToImport.length === 0) {
                  return true;
                }

                try {
                  const vault = channelKeyManager.getVault(channelId);
                  for (const item of keysToImport) {
                    const rawKeyMat = Uint8Array.from(atob(item.encryptedChannelKey), (c) =>
                      c.charCodeAt(0)
                    );
                    await vault.rotateKey(item.keyVersion, rawKeyMat);
                  }

                  const channelSvc = new ChannelService();
                  await channelSvc
                    .markKeyDistributionReceived(channelId, distributionId, keyVersion)
                    .catch(() => {});
                  await channelSvc
                    .ackKeyDistribution(channelId, distributionId, keyVersion)
                    .catch(() => {});

                  const displayName = data.channelName || channelId;
                  await addSystemMessage(
                    `Vous avez ete invite a rejoindre #${displayName}. Les cles de chiffrement ont ete recues en prive.`,
                    convoKey
                  );
                  log(
                    `[CHANNEL-KEY] ${keysToImport.length} cle(s) recue(s) via MLS pour #${displayName} (jusqu'a v${keyVersion}).`
                  );
                } catch (e) {
                  log(
                    `[CHANNEL-KEY] Echec traitement distribution ${distributionId}: ${e instanceof Error ? e.message : String(e)}`
                  );
                }

                return true;
              }

              if (event === 'groupRenamed' && data.newName) {
                conversations.set(convoKey, { ...convo, name: data.newName });
                if (storage) await saveConversation(convoKey);
                await addSystemMessage(
                  `${senderNorm} a renommé le groupe en "${data.newName}"`,
                  convoKey
                );
                log(`📝 Groupe renommé en "${data.newName}" par ${senderNorm}`);
                return true;
              }
              if (event === 'memberRemoved' && data.targetUser) {
                await addSystemMessage(
                  `${senderNorm} a retiré ${data.targetUser} du groupe`,
                  convoKey
                );
                return true;
              }
              if (event === 'memberAdded') {
                const added =
                  data.newUsers && Array.isArray(data.newUsers)
                    ? data.newUsers.join(', ')
                    : data.newUser;

                if (added) {
                  await addSystemMessage(`${senderNorm} a ajouté ${added} au groupe`, convoKey);
                  return true;
                }
              }
              if (event === 'groupDeleted') {
                await addSystemMessage(`${senderNorm} a supprimé le groupe`, convoKey);
                conversations.set(convoKey, { ...convo, isReady: false });
                if (storage) await saveConversation(convoKey);
                log(`[INFO] Groupe supprime par ${senderNorm} (archive localement)`);
                return true;
              }
              if (event === 'read_receipt') {
                const msgIds: string[] = data.messageIds ?? [];
                const c = conversations.get(convoKey);
                if (c && msgIds.length > 0) {
                  let updated = false;
                  for (const msgId of msgIds) {
                    const targetMsg = c.messages.find((m) => m.id === msgId);
                    if (targetMsg) {
                      if (!targetMsg.readBy) targetMsg.readBy = [];
                      if (!targetMsg.readBy.includes(senderNorm)) {
                        targetMsg.readBy.push(senderNorm);
                        updated = true;
                      }
                    }
                  }
                  if (updated) {
                    // Ne plus faire conversations.set()
                    if (storage) {
                      for (const msgId of msgIds) {
                        const m = c.messages.find((x) => x.id === msgId);
                        if (m) {
                          try {
                            await storage.saveMessage({ ...m, conversationId: convoKey }, pin);
                          } catch {
                            // Non-blocking
                          }
                        }
                      }
                    }
                    onReadReceiptReceived?.({
                      conversationKey: convoKey,
                      senderId: senderNorm,
                      messageIds: msgIds,
                    });
                  }
                }
                return true;
              }
              if (event === 'delete_message') {
                const c = conversations.get(convoKey);
                if (c && data.messageId) {
                  const targetMsg = c.messages.find((m) => m.id === data.messageId);
                  if (targetMsg && targetMsg.senderId === senderNorm) {
                    targetMsg.isDeleted = true;
                    targetMsg.content = 'Ce message a été supprimé.';
                    if (storage) {
                      try {
                        await storage.saveMessage({ ...targetMsg, conversationId: convoKey }, pin);
                      } catch {
                        // Non-blocking
                      }
                    }
                  }
                }
                return true;
              }
              if (event === 'edit_message' && data.messageId && data.newContent) {
                const c = conversations.get(convoKey);
                if (c) {
                  const targetMsg = c.messages.find((m) => m.id === data.messageId);
                  if (targetMsg && targetMsg.senderId === senderNorm) {
                    targetMsg.isEdited = true;
                    targetMsg.editedAt =
                      typeof data.editedAt === 'number' ? new Date(data.editedAt) : new Date();
                    targetMsg.content = data.newContent;
                    targetMsg.readBy = [];
                    if (storage) {
                      try {
                        await storage.saveMessage({ ...targetMsg, conversationId: convoKey }, pin);
                      } catch {
                        // Non-blocking
                      }
                    }
                  }
                }
                return true;
              }
              // Unknown system event — ignore silently
              if (event === 'remove_reaction' && data.messageId && data.emoji) {
                const reactions = messageReactions.get(data.messageId) || [];
                const filtered = reactions.filter(
                  (r) => !(r.userId === senderNorm && r.emoji === data.emoji)
                );
                messageReactions.set(data.messageId, filtered);

                // Persister la suppression en DB
                const c = conversations.get(convoKey);
                if (storage && c) {
                  const target = c.messages.find((m) => m.id === data.messageId);
                  if (target) {
                    try {
                      await storage.saveMessage(
                        {
                          id: target.id,
                          conversationId: convoKey,
                          senderId: target.senderId,
                          content: target.content,
                          timestamp: target.timestamp.getTime(),
                          readBy: target.readBy,
                          reactions: filtered,
                        },
                        pin
                      );
                    } catch {
                      // Non-blocking
                    }
                  }
                }
                return true;
              }
              // ── Relai peer-to-peer : un device en retard demande les messages manquants ──
              //
              // Répondre uniquement si le demandeur n'est pas nous-même.
              // On renvoie jusqu'à 50 messages text/reply après lastTimestamp,
              // encapsulés dans un unique sync_reply pour limiter le bruit réseau.
              // Les messages media sont omis (clés CEK non stockées localement).
              if (
                event === 'sync_request' &&
                data.requesterDeviceId &&
                data.requesterDeviceId !== mlsService.getDeviceId()
              ) {
                const lastTs: number = data.lastTimestamp ?? 0;
                const c = conversations.get(convoKey);
                if (c) {
                  const toRelay = c.messages
                    .filter((m) => m.timestamp.getTime() > lastTs && !m.isSystem)
                    .slice(-50) // cap à 50 pour éviter un message géant
                    .map((m) => ({
                      id: m.id,
                      senderId: m.senderId,
                      content: m.content,
                      timestamp: m.timestamp.getTime(),
                    }));

                  if (toRelay.length > 0) {
                    log(
                      `[SYNC] sync_request de ${data.requesterDeviceId} — relai de ${toRelay.length} message(s) pour groupe=${convoKey}`
                    );
                    const replyPayload = encodeAppMessage(
                      mkSystem('sync_reply', JSON.stringify({ messages: toRelay }))
                    );
                    mlsService.sendMessage(convoKey, replyPayload).catch(() => {});
                  }
                }
                return true;
              }

              // ── Réception d'un relai peer-to-peer ──────────────────────────────────────
              //
              // Les messages sync_reply contiennent les `content` (enveloppes déjà
              // sérialisées) d'un pair qui les a déchiffrés. On les injecte directement
              // dans addMessageToChat : le dedup par messageId absorbe les doublons.
              if (event === 'sync_reply' && Array.isArray(data.messages)) {
                log(
                  `[SYNC] sync_reply reçu — ${data.messages.length} message(s) à injecter pour groupe=${convoKey}`
                );
                const sorted = [...data.messages].sort(
                  (a: any, b: any) => a.timestamp - b.timestamp
                );
                for (const m of sorted) {
                  if (m.id && m.senderId && m.content) {
                    await addMessageToChat(
                      String(m.senderId).toLowerCase(),
                      String(m.content),
                      convoKey,
                      undefined,
                      false,
                      String(m.id),
                      new Date(m.timestamp)
                    );
                  }
                }
                return true;
              }

              // Unknown system event — ignore silently
              return true;
            }

            // Fallback: treat raw bytes as legacy plain text
            const legacyText = new TextDecoder().decode(decryptedBytes);
            await addMessageToChat(
              senderNorm,
              serializeEnvelope(mkTextEnvelope(legacyText)),
              convoKey
            );
          } else if (!isCommit && !epochRecoveryGroups.has(convoKey)) {
            // Repeated null on non-commit traffic is a strong signal of local MLS
            // divergence (message is routed but cannot be decrypted into app payload).
            const nullCount = (groupNullAppFailures.get(convoKey) ?? 0) + 1;
            groupNullAppFailures.set(convoKey, nullCount);
            log(
              `[RECOVER] Message non-commit non déchiffrable sur "${convoKey}" (${nullCount}/${NULL_APP_THRESHOLD})`
            );
            if (nullCount >= NULL_APP_THRESHOLD) {
              epochRecoveryGroups.add(convoKey);
              log(`[RECOVER] Etat MLS suspect sur "${convoKey}" — oubli MLS + reinvite_request`);
              mlsService.forgetGroup(convo.id);
              conversations.set(convoKey, { ...convo, isReady: false });
              if (storage) saveConversation(convoKey).catch(() => {});
              await mlsService.sendReinviteRequest(convo.id);
            }
          }
          // Reset phantom failure counter on any successful processing
          groupMlsFailures.delete(convoKey);
          return true;
        } catch (_e) {
          const errMsg = String(_e);
          // Re-throw GAP errors so TauriMlsService.processQueue can trigger the catch-up mechanism.
          // The catch block there (TauriMlsService.ts) detects GAP_QUEUED:, skips the ACK, and
          // calls fetchMissingMessages. If we swallow it here and return false, processQueue
          // still ACKs the message (line 548) and the gap is never recovered.
          if (errMsg.includes('GAP_QUEUED:')) {
            throw _e;
          }
          if (errMsg.includes('CannotDecryptOwnMessage')) {
            return true; // ACK it so it isn't resent
          }

          // Ratchet de génération dépassé : message déjà traité ou rélivraison de l'historique
          // après reconnexion. La clé symétrique est consommée, aucune récupération possible.
          if (
            errMsg.includes('TooDistantInThePast') ||
            errMsg.includes('CiphertextGenerationOutOfBounds')
          ) {
            return true; // ACK silencieux — irrecuperable
          }

          // Stale message (msg_epoch < group_epoch): our own echoed commit or a
          // commit already applied by another path.  The Rust layer handles most of
          // these, but some slip through (e.g. PublicMessage commits).  ACK silently.
          // Future epoch (msg_epoch > group_epoch): our local state is behind — drop
          // the stale MLS state and trigger a re-sync via reinvite_request.
          const meMatch = errMsg.match(/msg_epoch=(\d+)/);
          const geMatch = errMsg.match(/group_epoch=(\d+)/);
          if (meMatch && geMatch) {
            const me = parseInt(meMatch[1], 10);
            const ge = parseInt(geMatch[1], 10);
            if (me < ge) {
              return true; // Stale — already processed
            }
            if (me > ge && !epochRecoveryGroups.has(convoKey)) {
              epochRecoveryGroups.add(convoKey);
              log(
                `[RECOVER] Epoch périmée sur "${convoKey}" (local: ${ge}, msg: ${me}) — oubli MLS + reinvite_request`
              );
              mlsService.forgetGroup(convo.id, me); // Fix F: min_epoch = me
              conversations.set(convoKey, { ...convo, isReady: false });
              if (storage) saveConversation(convoKey).catch(() => {});
              await mlsService.sendReinviteRequest(convo.id);
            }
            // Fix E: me === ge + SenderDataDecryption = secrets divergés (race condition)
            if (
              me === ge &&
              errMsg.toLowerCase().includes('senderdata') &&
              !epochRecoveryGroups.has(convoKey)
            ) {
              epochRecoveryGroups.add(convoKey);
              log(
                `[RECOVER] Divergence secrets (SenderDataDecryption) sur "${convoKey}" (epoch: ${ge}) — oubli MLS + reinvite_request`
              );
              mlsService.forgetGroup(convo.id, ge); // Fix F: min_epoch = ge
              conversations.set(convoKey, { ...convo, isReady: false });
              if (storage) saveConversation(convoKey).catch(() => {});
              await mlsService.sendReinviteRequest(convo.id);
            }
            return true; // ACK toujours pour les erreurs d'epoch
          }

          if (errMsg.includes('WrongEpoch')) {
            return true; // WrongEpoch sans numéros parsables — ACK silencieux
          }

          // Fix E fallback: SenderDataDecryption sans epoch parsable — même récupération
          if (errMsg.toLowerCase().includes('senderdata') && !epochRecoveryGroups.has(convoKey)) {
            epochRecoveryGroups.add(convoKey);
            log(
              `[RECOVER] Divergence secrets (SenderDataDecryption) sur "${convoKey}" — oubli MLS + reinvite_request`
            );
            mlsService.forgetGroup(convo.id);
            conversations.set(convoKey, { ...convo, isReady: false });
            if (storage) saveConversation(convoKey).catch(() => {});
            await mlsService.sendReinviteRequest(convo.id);
            return true;
          }

          log(`Erreur message de ${senderNorm} (groupe connu): ${errMsg}`);
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
            if (failures >= PHANTOM_THRESHOLD) {
              log(
                `🧹 Suppression locale du groupe fantôme "${convoKey}" après ${failures} échecs consécutifs`
              );
              if (storage) {
                await storage
                  .deleteConversation(convoKey)
                  .catch((e) => log(`Erreur suppression DB "${convoKey}": ${e}`));
              }
              conversations.delete(convoKey);
              groupMlsFailures.delete(convoKey);
              groupNullAppFailures.delete(convoKey);
              if (getSelectedContact() === convoKey) {
                setSelectedContact(null);
              }
            }
          }

          return false;
        }
      }

      if (!isWelcome) {
        // Buffer le message — le Welcome est peut-être encore en transit.
        // Sans ce buffer, les commits qui arrivent avant le Welcome sont perdus,
        // créant une divergence d'epoch permanente (AeadError).
        if (groupId) {
          const buf = pendingGroupMessages.get(groupId) ?? [];
          if (buf.length < BUFFER_MAX_PER_GROUP) {
            buf.push({ sender, content });
            pendingGroupMessages.set(groupId, buf);
            log(`[BUFFER] Message bufferise pour groupe ${groupId} (${buf.length} en attente)`);
          }
          return false; // Keep in queue: Welcome may also be queued and will be retried
        }
        log(`Ignoré: message sans groupe ni conversation`);
        return false;
      }

      // Unknown group → Process Welcome message
      try {
        const joinedGroupId = await mlsService.processWelcome(content, ratchetTreeBytes);

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

        // Persist MLS state immediately after Welcome — a crash before this
        // would lose the joined group and require a fresh Welcome.
        try {
          const stBytes = await mlsService.saveState(pin);
          await saveMlsState(userId, stBytes);
        } catch {
          // Non-blocking: state will be saved on next message
        }

        let groupName = senderNorm;
        let isGroupFromApi: boolean | null = null;

        // Fetch group metadata (include auth token so the endpoint can answer)
        try {
          let authHeader: Record<string, string> = {};
          try {
            const { getToken } = await import('$lib/stores/auth');
            const token = await getToken();
            if (token) authHeader = { Authorization: `Bearer ${token}` };
          } catch {
            // Silent: proceed without auth header if token unavailable
          }
          const gRes = await fetch(
            `${historyBaseUrl}/api/mls-api/groups/${groupId || joinedGroupId}`,
            { headers: authHeader }
          );
          if (gRes.ok) {
            const gData = await gRes.json();
            if (gData?.name) groupName = gData.name;
            // Use the explicit isGroup field from the backend
            if (typeof gData?.isGroup === 'boolean') {
              isGroupFromApi = gData.isGroup;
            }
          }
        } catch {
          // Silent fallback if group metadata fetch fails
        }

        let isDirect = false;
        let directPeerId = '';

        // Determine if this is a direct conversation:
        // 1. If backend explicitly returns isGroup=false, it's a direct conversation
        // 2. Fallback to name pattern detection for backwards compatibility
        if (isGroupFromApi === false) {
          // Explicit 1-to-1 conversation from backend
          isDirect = true;
          // Extract peer from name pattern (userId::contact) or use sender
          if (groupName.includes('::')) {
            const parts = groupName
              .split('::')
              .map((p) => p.trim().toLowerCase())
              .filter(Boolean);
            const current = userId.toLowerCase();
            const unique = [...new Set(parts)];
            const peer = unique.find((p) => p !== current);
            directPeerId = peer || senderNorm;
          } else {
            directPeerId = senderNorm;
          }
        } else if (isGroupFromApi === null && groupName.includes('::')) {
          // Fallback: name pattern detection for legacy groups
          const parts = groupName
            .split('::')
            .map((p) => p.trim().toLowerCase())
            .filter(Boolean);
          const current = userId.toLowerCase();
          const unique = [...new Set(parts)];
          const peer = unique.find((p) => p !== current);
          if (peer) {
            isDirect = true;
            directPeerId = peer;
          }
        }
        // If isGroupFromApi === true, it's explicitly a group, so isDirect stays false

        // Since the map is keyed by groupId, find directly.
        let newConvoKey = joinedGroupId; // default — map key = groupId
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
          conversations.set(newConvoKey, {
            ...convo,
            id: joinedGroupId,
            name: isDirect ? directPeerId : groupName,
            isReady: true,
          });
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
          for (const msg of buffered) {
            try {
              const decBytes = await mlsService.processIncomingMessage(joinedGroupId, msg.content);
              if (decBytes) {
                try {
                  const appMsg = decodeAppMessage(decBytes);
                  if (appMsg?.text) {
                    await addMessageToChat(
                      msg.sender.toLowerCase(),
                      serializeEnvelope(mkTextEnvelope(appMsg.text.content ?? '')),
                      newConvoKey,
                      undefined,
                      false,
                      appMsg.messageId || undefined
                    );
                  } else if (appMsg?.reply) {
                    const rt = appMsg.reply.replyTo
                      ? {
                          id: appMsg.reply.replyTo.id ?? '',
                          senderId: appMsg.reply.replyTo.senderId ?? '',
                          content: appMsg.reply.replyTo.preview ?? '',
                        }
                      : undefined;
                    await addMessageToChat(
                      msg.sender.toLowerCase(),
                      serializeEnvelope(mkTextEnvelope(appMsg.reply.content ?? '', rt)),
                      newConvoKey,
                      undefined,
                      false,
                      appMsg.messageId || undefined
                    );
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
        if (errStr.includes('NoMatchingKeyPackage')) {
          // Le KeyPackage utilisé pour générer ce Welcome a été consommé (one-time prekey)
          // ou l'appareil a été réinitialisé. Ce Welcome est inutilisable pour ce device.
          // On demande au groupe de renvoyer un Welcome avec un nouveau KeyPackage.
          log(
            `[WELCOME] KeyPackage introuvable pour groupe ${groupId} — Welcome inutilisable. ` +
              `Envoi d'un welcome_request pour se faire ré-inviter. Erreur: ${errStr.slice(0, 200)}`
          );
          if (groupId) {
            mlsService.sendWelcomeRequest(groupId).catch((e) => {
              log(`[WELCOME] sendWelcomeRequest échoué pour groupe=${groupId}: ${e}`);
            });
          }
          // Retourner false pour que le caller ACK ce Welcome (il est définitivement inutile).
          return false;
        }
        // Erreur inattendue (corruption, mismatch de cipher suite…) : on ne retourne PAS false.
        // On relance l'exception pour que processQueue n'ACK PAS le message côté serveur.
        // Ainsi, le Welcome reste en file de livraison et sera retenté à la prochaine connexion.
        log(
          `[WELCOME] Erreur irrécupérable processWelcome pour groupe ${groupId} — NE PAS ACK, retry à la prochaine connexion. Erreur: ${errStr.slice(0, 300)}`
        );
        throw _e;
      }
    }
  );

  // Fail-safe universel : déclenché après 3 échecs consécutifs de gap recovery.
  // Recréé le groupe MLS depuis zéro avec un verrou optimiste anti-concurrence.
  mlsService.onUnrecoverable((groupId) => {
    const convo = conversations.get(groupId);
    if (!convo) return;
    log(`[BOOTSTRAP] État irrécupérable sur groupe=${groupId} — re-bootstrap en cours...`);
    void (async () => {
      try {
        const members = await mlsService.getGroupMembers(groupId);
        const memberUserIds = [...new Set(members.map((m) => m.userId))];
        const outcome = await mlsService.bootstrapDeadConversation(groupId, memberUserIds, pin);
        if (outcome === 'bootstrapped') {
          conversations.set(groupId, { ...conversations.get(groupId)!, isReady: true });
          if (storage) saveConversation(groupId).catch(() => {});
          log(`[BOOTSTRAP] Groupe ${groupId} re-bootstrappé avec succès.`);
        } else if (outcome === 'conflict') {
          log(`[BOOTSTRAP] Race condition sur groupe=${groupId} — attente du Welcome du gagnant.`);
        } else {
          log(`[BOOTSTRAP] Aucun membre disponible pour groupe=${groupId}.`);
        }
      } catch (e) {
        log(
          `[BOOTSTRAP] Échec re-bootstrap groupe=${groupId}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    })();
  });

  // When server history is empty during gap recovery:
  //   attempt=1 → ask online peers to relay their cached messages (sync_request)
  //   attempt≥2 → server + peers both failed; escalate to forgetGroup + sendReinviteRequest
  mlsService.onSyncNeeded((groupId, attempt) => {
    const convo = conversations.get(groupId);
    if (!convo?.isReady) return;

    if (attempt >= 2) {
      log(
        `[SYNC] Gap irrécupérable sur groupe=${groupId} après ${attempt} tentatives — oubli MLS + reinvite_request`
      );
      mlsService.forgetGroup(groupId);
      conversations.set(groupId, { ...convo, isReady: false });
      if (storage) saveConversation(groupId).catch(() => {});
      mlsService.sendReinviteRequest(groupId).catch((e) => {
        log(`[SYNC] sendReinviteRequest échoué pour groupe=${groupId}: ${e}`);
      });
      return;
    }

    // First attempt: try peer relay before giving up.
    const lastTs =
      convo.messages.length > 0
        ? Math.max(...convo.messages.map((m: ChatMessage) => m.timestamp.getTime()))
        : 0;
    log(
      `[SYNC] Relai peer-to-peer pour groupe=${groupId} (lastTs=${lastTs}, tentative ${attempt})`
    );
    const payload = encodeAppMessage(
      mkSystem(
        'sync_request',
        JSON.stringify({ requesterDeviceId: mlsService.getDeviceId(), lastTimestamp: lastTs })
      )
    );
    mlsService.sendMessage(groupId, payload).catch((e) => {
      log(`[SYNC] Impossible d'envoyer sync_request pour groupe=${groupId}: ${e}`);
    });
  });
}

interface ConnectionDeps {
  mlsService: IMlsService;
  userId: string;
  pin: string;
  scheduleReconnect: () => void;
  setIsWsConnected: (value: boolean) => void;
  setReconnectAttempts: (value: number) => void;
  processDeviceInvitationsLocally: () => Promise<void>;
  log: (msg: string) => void;
}

/**
 * Initialise la connexion WebSocket et génère un KeyPackage.
 * Gère la reconnexion automatique en cas de déconnexion.
 */
export async function initializeConnection(deps: ConnectionDeps): Promise<void> {
  const {
    mlsService,
    userId: _userId,
    pin,
    scheduleReconnect,
    setIsWsConnected,
    setReconnectAttempts,
    processDeviceInvitationsLocally,
    log,
  } = deps;

  // Multi-tab guard: only the leader tab opens the WebSocket.
  if (!isTabLeader) {
    log('[TAB] Onglet follower — skip initializeConnection.');
    return;
  }

  log('Connexion Gateway...');
  try {
    const { getToken } = await import('$lib/stores/auth');
    const token = await getToken();
    await mlsService.connect(token);
    setIsWsConnected(true);
    setReconnectAttempts(0);
    log('Connecté au réseau !');
    // Fetch any messages that arrived while this device was disconnected or
    // offline. Called here (rather than inside connect/onopen) so the intent
    // is explicit and the caller controls the lifecycle.
    mlsService
      .fetchPendingMessages()
      .catch((e) =>
        log(
          `[WARN] Echec récupération messages initiaux: ${e instanceof Error ? e.message : String(e)}`
        )
      );
    mlsService.onDisconnect(scheduleReconnect);

    // Notify the gateway immediately when the tab / app is closed so the
    // presence key is removed right away, rather than waiting for the TTL
    // or heartbeat timeout (up to 60 s).  Only registered on the leader tab
    // (this function is only called on the leader).
    if (typeof window !== 'undefined') {
      const sendDisconnectOnUnload = () => mlsService.sendDisconnect();
      window.addEventListener('beforeunload', sendDisconnectOnUnload, { once: true });
    }

    // When a sibling device (same user, different device) signals that it needs
    // to be added to a group, immediately run the pending-invitations loop.
    // Without these handlers the WS events are received and logged but ignored —
    // the triggering device is never added to the MLS tree.
    mlsService.onReinviteRequest((senderDeviceId, groupId) => {
      log(
        `[SIBLING] reinvite_request de ${senderDeviceId} (groupe ${groupId}) → traitement invitations`
      );
      processDeviceInvitationsLocally().catch(() => {});
    });

    // onWelcomeRequest is registered in useChatSession.login() with the targeted
    // handleWelcomeRequest handler. Do NOT register it here — it would overwrite
    // that handler with a generic processDeviceInvitationsLocally call.
  } catch (_wsErr: unknown) {
    const msg = _wsErr instanceof Error ? _wsErr.message : String(_wsErr);
    log(`Gateway inaccessible: ${msg}`);
  }

  // Generate and publish KeyPackage FIRST (before syncing devices)
  // This ensures other devices will fetch our fresh KeyPackage, not a stale one.
  try {
    await mlsService.generateKeyPackage(pin);
    log('KeyPackage publié.');
  } catch {
    // Silent fallback if key package generation fails
  }

  // On every connect, cross-check server-side membership status with local MLS state:
  //   • pending          → send a welcome_request so any online group member can invite us
  //   • stale            → send a reinvite_request; the receiving peer runs
  //                        processPendingInvitations which kicks the stale leaf first (remove
  //                        commit), then re-adds the device (add commit + Welcome). Cannot use
  //                        welcome_request here because the leaf is still in the tree.
  //   • welcome_received → normally do nothing, BUT if local state is missing (e.g. storage
  //                        cleared, reinstall) reset to pending and send a welcome_request so
  //                        we get re-invited instead of being silently stuck
  try {
    const memberships = await mlsService.getDeviceMemberships(_userId, mlsService.getDeviceId());
    const localGroups = new Set(mlsService.getLocalGroups());
    for (const m of memberships) {
      if (m.status === 'pending') {
        mlsService.sendWelcomeRequest(m.groupId);
        log(`[SYNC] welcome_request envoyé pour groupe ${m.groupId}`);
      } else if (m.status === 'stale') {
        // Wipe local MLS state before requesting reinvite: the stale device's leaf
        // is still in everyone's tree, so the peer will kick it (remove commit) and
        // re-add it (add commit + Welcome). The Welcome can only be processed if the
        // local group state is gone — otherwise processWelcome would find an existing
        // group and fail.
        mlsService.forgetGroup(m.groupId);
        await mlsService.sendReinviteRequest(m.groupId);
        log(`[SYNC] reinvite_request envoyé (stale sur groupe ${m.groupId}, état local effacé)`);
      } else if (m.status === 'welcome_received' && !localGroups.has(m.groupId)) {
        // Server believes we are a full member but local MLS state is gone.
        // If the server belives so, the other devices too -> equivalent to stale / need to be reinvited
        // Reset to pending so the receiving device accepts the welcome_request.
        await mlsService
          .updateInvitationStatus(mlsService.getDeviceId(), _userId, m.groupId, 'stale')
          .catch(() => {});
        await mlsService.sendReinviteRequest(m.groupId);
        log(`[SYNC] welcome_request envoyé (état local manquant pour ${m.groupId})`);
      }
    }

    // Detect groups where this device has no DeviceGroupMembership row at all.
    // Happens after a device ID reset (credential mismatch recovery) — the new device
    // ID has never been registered, so getDeviceMemberships returns nothing for it.
    // getUserGroups returns every group the USER belongs to; send welcome_request for
    // any group that is absent from both the DB rows and the local MLS state.
    const membershipGroupIds = new Set(memberships.map((m) => m.groupId));
    const userGroups = await mlsService
      .getUserGroups(_userId)
      .catch(() => [] as { groupId: string; name: string; isGroup: boolean }[]);
    for (const group of userGroups) {
      if (!membershipGroupIds.has(group.groupId) && !localGroups.has(group.groupId)) {
        mlsService.sendWelcomeRequest(group.groupId).catch(() => {});
        log(`[SYNC] welcome_request envoyé (device inconnu du groupe ${group.groupId})`);
      }
    }
  } catch (e) {
    log(`[SYNC] Échec récupération memberships: ${e}`);
  }

  // Small delay to allow KeyPackage propagation before syncing
  // This helps avoid race conditions where we fetch stale KeyPackages
  await new Promise((r) => setTimeout(r, 500));

  // Sync own devices to existing groups AFTER publishing our KeyPackage
  processDeviceInvitationsLocally().catch(() => {});
}
