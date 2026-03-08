import type { IMlsService } from '$lib/mlsService';
import type { IStorage } from '$lib/db';
import type { ChatMessage, Conversation } from '$lib/types';
import { toHex } from '$lib/utils/hex';
import type { SvelteMap } from 'svelte/reactivity';
import type { MessageReaction } from '$lib/types';

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
    messageId?: string
  ) => Promise<void>;
  addSystemMessage: (content: string, contactName: string) => Promise<void>;
  loadHistoryForConversation: (contactName: string, groupId: string) => Promise<void>;
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
    log,
  } = deps;

  mlsService.onMessage(async (sender, content, groupId): Promise<boolean> => {
    log(`Message de ${sender} (${content.length} octets) - Grp: ${groupId}`);
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
    if (!convoKey && conversations.has(senderNorm)) convoKey = senderNorm;

    // Process message for known conversation
    if (convoKey) {
      const convo = conversations.get(convoKey)!;
      try {
        const decrypted = await mlsService.processIncomingMessage(convo.groupId, content);

        // Auto-save MLS state
        try {
          const stBytes = await mlsService.saveState(pin);
          localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));
        } catch {
          // Silent fallback if autosave fails
        }

        if (decrypted) {
          // Try to parse as JSON control message
          try {
            const parsed = JSON.parse(decrypted);

            // Group renamed
            if (parsed.type === 'groupRenamed' && parsed.newName) {
              conversations.set(convoKey, { ...convo, name: parsed.newName });
              if (storage) await saveConversation(convoKey);
              await addSystemMessage(
                `${senderNorm} a renommé le groupe en "${parsed.newName}"`,
                convoKey
              );
              log(`📝 Groupe renommé en "${parsed.newName}" par ${senderNorm}`);
              return true;
            }

            // Member removed
            if (parsed.type === 'memberRemoved' && parsed.targetUser) {
              await addSystemMessage(
                `${senderNorm} a retiré ${parsed.targetUser} du groupe`,
                convoKey
              );
              return true;
            }

            // Member added
            if (parsed.type === 'memberAdded' && parsed.newUser) {
              await addSystemMessage(`${senderNorm} a ajouté ${parsed.newUser} au groupe`, convoKey);
              return true;
            }

            // Group deleted
            if (parsed.type === 'groupDeleted') {
              log(`🗑️ Groupe supprimé par ${senderNorm}`);
              if (storage) await storage.deleteConversation(convoKey);
              conversations.delete(convoKey);
              if (selectedContact === convoKey) {
                setSelectedContact(null);
                setMobileView('list');
              }
              return true;
            }

            // Reaction
            if (parsed.type === 'reaction' && parsed.messageId && parsed.emoji) {
              const reactions = messageReactions.get(parsed.messageId) || [];
              const filtered = reactions.filter((r) => r.userId !== senderNorm);
              filtered.push({ emoji: parsed.emoji, userId: senderNorm });
              messageReactions.set(parsed.messageId, filtered);
              log(`👍 ${senderNorm} a réagi avec ${parsed.emoji}`);
              return true;
            }

            // Read Receipt
            if (parsed.type === 'read_receipt' && Array.isArray(parsed.messageIds)) {
              const convo = conversations.get(convoKey);
              if (convo) {
                let updated = false;
                const newMsgs = [...convo.messages];
                for (const msgId of parsed.messageIds) {
                  const idx = newMsgs.findIndex(m => m.id === msgId);
                  if (idx !== -1) {
                    const msg = { ...newMsgs[idx] };
                    const readBy = msg.readBy || [];
                    if (!readBy.includes(senderNorm)) {
                      msg.readBy = [...readBy, senderNorm];
                      newMsgs[idx] = msg;
                      updated = true;
                    }
                  }
                }
                if (updated) {
                  conversations.set(convoKey, { ...convo, messages: newMsgs });
                }
              }
              return true;
            }

            // Delete Message
            if (parsed.type === 'delete_message' && parsed.messageId) {
              const convo = conversations.get(convoKey);
              if (convo) {
                const newMsgs = [...convo.messages];
                const MathMsg = newMsgs.findIndex(m => m.id === parsed.messageId);
                // Ensure the person deleting is the original author
                if (MathMsg !== -1 && newMsgs[MathMsg].senderId === senderNorm) {
                  newMsgs[MathMsg] = { ...newMsgs[MathMsg], isDeleted: true, content: 'Ce message a été supprimé.' };
                  conversations.set(convoKey, { ...convo, messages: newMsgs });
                }
              }
              return true;
            }

            // Edit Message
            if (parsed.type === 'edit_message' && parsed.messageId && parsed.newContent) {
              const convo = conversations.get(convoKey);
              if (convo) {
                const newMsgs = [...convo.messages];
                const MathMsg = newMsgs.findIndex(m => m.id === parsed.messageId);
                if (MathMsg !== -1 && newMsgs[MathMsg].senderId === senderNorm) {
                  // Only text messages should be editable simply like this
                  newMsgs[MathMsg] = { ...newMsgs[MathMsg], isEdited: true, content: parsed.newContent };
                  conversations.set(convoKey, { ...convo, messages: newMsgs });
                }
              }
              return true;
            }

            // Reply message
            if (parsed.type === 'reply' && parsed.content) {
              await addMessageToChat(senderNorm, parsed.content, convoKey, parsed.replyTo, false, parsed.id);
              return true;
            }

            // Types media
            if (
               parsed.type === 'image' ||
               parsed.type === 'video' ||
               parsed.type === 'audio' ||
               parsed.type === 'file'
            ) {
              await addMessageToChat(senderNorm, decrypted, convoKey, undefined, false, parsed.id);
              return true;
            }

            // Standard text message
            if (parsed.type === 'text' && parsed.content) {
              await addMessageToChat(senderNorm, parsed.content, convoKey, undefined, false, parsed.id);
              return true;
            }
          } catch {
            // Not JSON or unknown control message → treat as plain text (legacy)
          }

          // Plain text message (legacy format)
          await addMessageToChat(senderNorm, decrypted, convoKey);
        }
        return true;
      } catch (_e) {
        const errMsg = String(_e);
        // Filter out normal OpenMLS behavior: you can't decrypt your own messages
        if (errMsg.includes('CannotDecryptOwnMessage')) {
          return false; // Silent ignore
        }
        log(`Erreur message (groupe connu): ${errMsg}`);
        return false;
      }
    }

    // Unknown group → Process Welcome message
    try {
      const joinedGroupId = await mlsService.processWelcome(content);
      let groupName = senderNorm;

      // Fetch group metadata
      try {
        const gRes = await fetch(`${historyBaseUrl}/mls-api/groups/${groupId || joinedGroupId}`);
        if (gRes.ok) {
          const gData = await gRes.json();
          if (gData?.name) groupName = gData.name;
        }
      } catch {
        // Silent fallback if group metadata fetch fails
      }

      // Create new conversation
      conversations.set(senderNorm, {
        contactName: senderNorm,
        name: groupName,
        groupId: joinedGroupId,
        messages: [],
        isReady: true,
        mlsStateHex: null,
      });
      saveConversation(senderNorm);

      // Auto-save MLS state
      try {
        const stBytes = await mlsService.saveState(pin);
        localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));
      } catch {
        // Silent fallback if autosave fails
      }

      log(`✅ Handshake complété avec ${senderNorm}`);
      loadHistoryForConversation(senderNorm, joinedGroupId);
      return true;
    } catch {
      log(`Ignoré: pas un message pour un groupe existant ni un welcome.`);
      return false;
    }
  });
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
