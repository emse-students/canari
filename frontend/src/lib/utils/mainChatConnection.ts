import type { IMlsService } from '$lib/mlsService';
import type { IStorage } from '$lib/db';
import type { ChatMessage, Conversation } from '$lib/types';
import { toHex } from '$lib/utils/hex';
import type { SvelteMap } from 'svelte/reactivity';
import type { MessageReaction } from '$lib/types';
import { decodeAppMessage, MediaKind } from '$lib/proto/codec';
import { serializeEnvelope, mkTextEnvelope, mkMediaEnvelope } from '$lib/envelope';

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
  setMobileView: (value: 'list' | 'chat') => void;
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
  onCallSignal?: (senderId: string, callMsg: any) => void;
  log: (msg: string) => void;
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
    selectedContact,
    setSelectedContact,
    setMobileView,
    saveConversation,
    addMessageToChat,
    addSystemMessage,
    loadHistoryForConversation,
    onChannelMemberJoined,
    onChannelMemberKicked,
    onCallSignal,
    log,
  } = deps;

  // Compteur d'échecs MLS par conversation — détection des groupes fantômes
  const groupMlsFailures = new Map<string, number>();
  const PHANTOM_THRESHOLD = 3;

  if ('onChannelEvent' in mlsService) {
    (mlsService as any).onChannelEvent = (event: any) => {
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

      if (event.type === 'channel.message.created') {
        const data = event.data;
        const channelId = `channel_${data.channelId}`;
        const sender = data.senderId;
        // Check if we have this channel in our conversations list
        let convoKey: string | undefined = conversations.has(channelId) ? channelId : undefined;
        if (!convoKey) {
          for (const [k, c] of conversations.entries()) {
            if (c.groupId === channelId) {
              convoKey = k;
              break;
            }
          }
        }

        if (convoKey) {
          // Add to chat (we ignore real crypto for the moment in this quick integration,
          // usually we'd pass data.ciphertext to the crypto engine if needed, but this MVP routes it)
          addMessageToChat(
            sender,
            data.ciphertext || data.plaintext || '[Message chiffré]',
            convoKey,
            undefined,
            false,
            data.id,
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
    async (sender, content, groupId, isWelcome, ratchetTreeBytes): Promise<boolean> => {
      log(
        `Message de ${sender} (${content.length} octets) - Grp: ${groupId} (isWelcome: ${!!isWelcome})`
      );
      const senderNorm = sender.toLowerCase();

      // Find conversation by groupId or sender
      let convoKey: string | undefined;
      if (groupId) {
        for (const [k, c] of conversations.entries()) {
          if (c.groupId === groupId) {
            convoKey = k;
            break;
          }
        }
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

      // Process message for known conversation
      if (convoKey && !isWelcome) {
        const convo = conversations.get(convoKey)!;
        try {
          const decryptedBytes = await mlsService.processIncomingMessage(convo.groupId, content);

          // Auto-save MLS state
          try {
            const stBytes = await mlsService.saveState(pin);
            localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));
          } catch {
            // Silent fallback if autosave fails
          }

          if (decryptedBytes) {
            const msg = decodeAppMessage(decryptedBytes);

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
              const reactions = messageReactions.get(msg.reaction.messageId ?? '') || [];
              const filtered = reactions.filter((r) => r.userId !== senderNorm);
              filtered.push({ emoji: msg.reaction.emoji ?? '', userId: senderNorm });
              messageReactions.set(msg.reaction.messageId ?? '', filtered);
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
                  const newMsgs = [...c.messages];
                  for (const msgId of msgIds) {
                    const idx = newMsgs.findIndex((m) => m.id === msgId);
                    if (idx !== -1) {
                      const m = { ...newMsgs[idx] };
                      const readBy = m.readBy || [];
                      if (!readBy.includes(senderNorm)) {
                        m.readBy = [...readBy, senderNorm];
                        newMsgs[idx] = m;
                        updated = true;
                      }
                    }
                  }
                  if (updated) conversations.set(convoKey, { ...c, messages: newMsgs });
                }
                return true;
              }
              if (event === 'delete_message') {
                const c = conversations.get(convoKey);
                if (c && data.messageId) {
                  const newMsgs = [...c.messages];
                  const idx = newMsgs.findIndex((m) => m.id === data.messageId);
                  if (idx !== -1 && newMsgs[idx].senderId === senderNorm) {
                    newMsgs[idx] = {
                      ...newMsgs[idx],
                      isDeleted: true,
                      content: 'Ce message a été supprimé.',
                    };
                    conversations.set(convoKey, { ...c, messages: newMsgs });
                  }
                }
                return true;
              }
              if (event === 'edit_message' && data.messageId && data.newContent) {
                const c = conversations.get(convoKey);
                if (c) {
                  const newMsgs = [...c.messages];
                  const idx = newMsgs.findIndex((m) => m.id === data.messageId);
                  if (idx !== -1 && newMsgs[idx].senderId === senderNorm) {
                    const editedAt =
                      typeof data.editedAt === 'number' ? new Date(data.editedAt) : new Date();
                    newMsgs[idx] = {
                      ...newMsgs[idx],
                      isEdited: true,
                      editedAt,
                      content: data.newContent,
                      readBy: [],
                    };
                    conversations.set(convoKey, { ...c, messages: newMsgs });
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
          }
          return true;
        } catch (_e) {
          const errMsg = String(_e);
          if (errMsg.includes('CannotDecryptOwnMessage') || errMsg.includes('WrongEpoch')) {
            return true; // ACK it so it isn't resent
          }
          log(`Erreur message (groupe connu): ${errMsg}`);

          // Détection de groupe fantôme : le groupId existe dans nos conversations
          // mais n'est plus dans l'état WASM MLS → nettoyage automatique après N échecs
          const isPhantom =
            errMsg.toLowerCase().includes('groupe introuvable') ||
            errMsg.toLowerCase().includes('group not found');
          if (isPhantom) {
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
              if (selectedContact === convoKey) {
                setSelectedContact(null);
                setMobileView('list');
              }
            }
          }

          return false;
        }
      }

      if (!isWelcome) {
        log(`Ignoré: message pour groupe inconnu ${groupId ?? '(sans groupe)'}`);
        return false;
      }

      // Unknown group → Process Welcome message
      try {
        const joinedGroupId = await mlsService.processWelcome(content, ratchetTreeBytes);
        let groupName = senderNorm;

        // Fetch group metadata
        try {
          const gRes = await fetch(
            `${historyBaseUrl}/api/mls-api/groups/${groupId || joinedGroupId}`
          );
          if (gRes.ok) {
            const gData = await gRes.json();
            if (gData?.name) groupName = gData.name;
          }
        } catch {
          // Silent fallback if group metadata fetch fails
        }

        const newConvoKey = `grp_${crypto.randomUUID()}`;
        // Create new conversation
        conversations.set(newConvoKey, {
          contactName: groupName,
          name: groupName,
          groupId: joinedGroupId,
          messages: [],
          isReady: true,
          mlsStateHex: null,
          conversationType: 'group',
        });
        saveConversation(newConvoKey);

        // Auto-save MLS state
        try {
          const stBytes = await mlsService.saveState(pin);
          localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));
        } catch {
          // Silent fallback if autosave fails
        }

        log(`[OK] Handshake complete avec ${senderNorm}`);
        loadHistoryForConversation(newConvoKey, joinedGroupId);
        return true;
      } catch (_e) {
        log(`Ignoré: pas un message pour un groupe existant ni un welcome. Erreur: ${String(_e)}`);
        return false;
      }
    }
  );
}

interface ConnectionDeps {
  mlsService: IMlsService;
  userId: string;
  pin: string;
  jwtSecret: string;
  isDev: boolean;
  scheduleReconnect: () => void;
  setIsWsConnected: (value: boolean) => void;
  setReconnectAttempts: (value: number) => void;
  syncOwnDevicesToGroupsLocally: () => Promise<void>;
  log: (msg: string) => void;
}

/**
 * Initialise la connexion WebSocket et génère un KeyPackage.
 * Gère la reconnexion automatique en cas de déconnexion.
 */
export async function initializeConnection(deps: ConnectionDeps): Promise<void> {
  const {
    mlsService,
    userId,
    pin,
    jwtSecret,
    isDev,
    scheduleReconnect,
    setIsWsConnected,
    setReconnectAttempts,
    syncOwnDevicesToGroupsLocally,
    log,
  } = deps;

  log('Connexion Gateway...');
  try {
    const { generateDevToken } = await import('$lib/utils/mainChatAuth');
    const token = await generateDevToken(userId, jwtSecret, isDev);
    await mlsService.connect(token);
    setIsWsConnected(true);
    setReconnectAttempts(0);
    log('Connecté au réseau !');
    mlsService.onDisconnect(scheduleReconnect);

    // Sync own devices to existing groups
    syncOwnDevicesToGroupsLocally().catch(() => {});
  } catch (_wsErr: unknown) {
    const msg = _wsErr instanceof Error ? _wsErr.message : String(_wsErr);
    log(`Gateway inaccessible: ${msg}`);
  }

  // Generate and publish KeyPackage
  try {
    await mlsService.generateKeyPackage(pin);
    log('KeyPackage publié.');
  } catch {
    // Silent fallback if key package generation fails
  }
}
