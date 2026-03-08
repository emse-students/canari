<script lang="ts">
  import { TauriMlsService, WebMlsService } from '$lib/mlsService';
  import type { IMlsService } from '$lib/mlsService';
  import { getStorage } from '$lib/db';
  import type { IStorage } from '$lib/db';
  import { exportBackup, importBackup } from '$lib/backup';
  import { onMount, tick } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { fade } from 'svelte/transition';
  import { LoginForm, Navbar, Sidebar, ChatArea, LogsPanel } from '$lib/components';

  // --- Types ---
  interface ChatMessage {
    id: string;
    senderId: string;
    content: string;
    timestamp: Date;
    isOwn: boolean;
    isSystem?: boolean;
    replyTo?: {
      id: string;
      senderId: string;
      content: string;
    };
  }

  interface MessageReaction {
    emoji: string;
    userId: string;
  }

  interface Conversation {
    contactName: string;
    name: string;
    groupId: string;
    messages: ChatMessage[];
    isReady: boolean;
    mlsStateHex: string | null;
  }

  // --- State (Runes) ---
  let userId = $state('');
  let pin = $state('');
  let isLoggedIn = $state(false);
  let isLoggingIn = $state(false);
  let loginError = $state('');
  let statusLog = $state<string[]>([]);
  let showLogs = $state(false);

  let conversations = new SvelteMap<string, Conversation>();
  let selectedContact = $state<string | null>(null);
  let mobileView = $state<'list' | 'chat'>('list'); // Gestion responsive

  let newContactInput = $state('');
  let newGroupInput = $state('');
  let inviteMemberInput = $state('');
  let _isAddingContact = $state(false);
  let messageText = $state('');
  let chatContainer = $state<HTMLElement>();

  let isWsConnected = $state(false);
  let myDeviceId = $state('');

  // Variables de débogage
  let lastKeyPackage = $state('');
  let incomingBytesHex = $state('');
  let lastCommit = $state('');
  let lastWelcome = $state('');

  // Valeurs dérivées pour rendu réactif
  let currentConvo = $derived(
    selectedContact ? (conversations.get(selectedContact) ?? null) : null
  );
  let _currentMessages = $derived(currentConvo?.messages ?? []);

  // Service MLS
  let mls: IMlsService | null = $state(null);

  // Persistent storage (IndexedDB on web, SQLite on Tauri)
  let storage: IStorage | null = $state(null);
  let isExporting = $state(false);
  let isImporting = $state(false);

  // Group management
  let groupMembers = $state<string[]>([]);
  let sendError = $state('');

  // Reactions (messageId -> array of reactions)
  let messageReactions = new SvelteMap<string, MessageReaction[]>();

  // Reply state
  let replyingTo = $state<ChatMessage | null>(null);

  // Helper to ensure MLS service exists
  function ensureMls(): IMlsService {
    if (!mls) throw new Error('MLS Service not initialized');
    return mls;
  }

  const historyBaseUrl = (() => {
    const env = import.meta.env.VITE_HISTORY_URL;
    if (env && env.trim()) return env;
    return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001';
  })();

  onMount(() => {
    const w = window as Window & { wasm_bindings_log?: (level: string, msg: string) => void };
    w.wasm_bindings_log = (level: string, msg: string) => {
      log(`[RUST::${level}] ${msg}`);
    };

    const w2 = window as Window & { __TAURI_INTERNALS__?: unknown };
    if (w2.__TAURI_INTERNALS__) {
      mls = new TauriMlsService();
      log('Initialisé en mode TAURI');
    } else {
      mls = new WebMlsService();
      log('Initialisé en mode WEB (WASM)');
    }

    // Auto-login si des identifiants sont mémorisés
    const savedUser = localStorage.getItem('canari_saved_user');
    const savedPin = localStorage.getItem('canari_saved_pin');
    if (savedUser && savedPin) {
      userId = savedUser;
      pin = savedPin;
      handleLogin();
    }
  });

  function log(msg: string) {
    statusLog = [...statusLog, `[${new Date().toLocaleTimeString()}] ${msg}`];
    tick().then(() => {
      const logEl = document.getElementById('logContainer');
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    });
  }

  // --- Auth & Initialisation ---

  async function generateDevToken(uid: string): Promise<string> {
    const secret = import.meta.env.VITE_JWT_SECRET;
    if (!secret) {
      const isDev = import.meta.env.DEV;
      throw new Error(
        isDev
          ? 'VITE_JWT_SECRET non configuré dans frontend/.env (développement)'
          : 'VITE_JWT_SECRET absent du bundle — vérifier le GitHub Secret JWT_SECRET dans Settings → Secrets → Actions'
      );
    }
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      throw new Error(
        'Erreur de sécurité : crypto.subtle indisponible.\n\n' +
          "Cause probable : l'application n'est pas accédée via HTTPS.\n" +
          'Vérifiez que Cloudflare Tunnel est actif et que vous accédez via https://canari-emse.fr'
      );
    }
    const header = JSON.stringify({ alg: 'HS256', typ: 'JWT' });
    const payload = JSON.stringify({
      sub: uid,
      exp: Math.floor(Date.now() / 1000) + 3600 * 24,
    });
    const b64url = (str: string) =>
      btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const unsignedToken = `${b64url(header)}.${b64url(payload)}`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, enc.encode(unsignedToken));
    const sigB64 = b64url(String.fromCharCode(...new Uint8Array(signature)));
    return `${unsignedToken}.${sigB64}`;
  }

  async function handleLogin() {
    if (!userId.trim() || !pin.trim()) {
      loginError = 'Veuillez remplir tous les champs.';
      return;
    }

    loginError = '';
    isLoggingIn = true;
    userId = userId.trim().toLowerCase();

    try {
      const mlsService = ensureMls(); // Ensure MLS is initialized

      log('Initialisation MLS...');
      let stateBytes: Uint8Array | undefined;
      const saved = localStorage.getItem('mls_autosave_' + userId);
      if (saved) {
        stateBytes = fromHex(saved);
        log('État chargé depuis le stockage local.');
      }

      await mlsService.init(userId, pin, stateBytes);
      myDeviceId = mlsService.getDeviceId();
      log(`Identité MLS initialisée (device: ${myDeviceId})`);

      // Initialise persistent storage (IndexedDB or SQLite), scoped per user
      storage = await getStorage(userId);
      log('Base de données locale initialisée.');

      isLoggedIn = true;
      // Mémoriser les identifiants pour auto-login au prochain chargement
      localStorage.setItem('canari_saved_user', userId);
      localStorage.setItem('canari_saved_pin', pin);
      await loadExistingConversations();

      // Listener de messages
      mlsService.onMessage(async (sender, content, groupId): Promise<boolean> => {
        log(`Message de ${sender} (${content.length} octets) - Grp: ${groupId}`);
        const senderNorm = sender.toLowerCase();

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

        if (convoKey) {
          const convo = conversations.get(convoKey)!;
          try {
            const decrypted = await mlsService.processIncomingMessage(convo.groupId, content);
            try {
              const stBytes = await mlsService.saveState(pin);
              localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));
            } catch {
              // Silent fallback if autosave fails
            }

            if (decrypted) {
              // Check if it's a control message (JSON)
              try {
                const parsed = JSON.parse(decrypted);

                if (parsed.type === 'groupRenamed' && parsed.newName) {
                  // Update group name locally
                  conversations.set(convoKey, { ...convo, name: parsed.newName });
                  if (storage) await saveConversation(convoKey);
                  await addSystemMessage(
                    `${senderNorm} a renommé le groupe en "${parsed.newName}"`,
                    convoKey
                  );
                  log(`📝 Groupe renommé en "${parsed.newName}" par ${senderNorm}`);
                  return true;
                }

                if (parsed.type === 'memberRemoved' && parsed.targetUser) {
                  await addSystemMessage(
                    `${senderNorm} a retiré ${parsed.targetUser} du groupe`,
                    convoKey
                  );
                  return true;
                }

                if (parsed.type === 'memberAdded' && parsed.newUser) {
                  await addSystemMessage(
                    `${senderNorm} a ajouté ${parsed.newUser} au groupe`,
                    convoKey
                  );
                  return true;
                }

                if (parsed.type === 'reaction' && parsed.messageId && parsed.emoji) {
                  // Add reaction to message
                  const reactions = messageReactions.get(parsed.messageId) || [];
                  // Remove previous reaction from same user, add new one
                  const filtered = reactions.filter((r) => r.userId !== senderNorm);
                  filtered.push({ emoji: parsed.emoji, userId: senderNorm });
                  messageReactions.set(parsed.messageId, filtered);
                  log(`👍 ${senderNorm} a réagi avec ${parsed.emoji}`);
                  return true;
                }

                if (parsed.type === 'reply' && parsed.content) {
                  // Reply message with quote
                  await addMessageToChat(senderNorm, parsed.content, convoKey, parsed.replyTo);
                  return true;
                }

                if (parsed.type === 'text' && parsed.content) {
                  // Standard text message (new format)
                  await addMessageToChat(senderNorm, parsed.content, convoKey);
                  return true;
                }
              } catch {
                // Not JSON or not a control message → treat as plain text (legacy)
              }
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

        // Si groupe inconnu -> Traitement Welcome
        try {
          const joinedGroupId = await mlsService.processWelcome(content);
          let groupName = senderNorm;

          try {
            const gRes = await fetch(
              `${historyBaseUrl}/mls-api/groups/${groupId || joinedGroupId}`
            );
            if (gRes.ok) {
              const gData = await gRes.json();
              if (gData?.name) groupName = gData.name;
            }
          } catch {
            // Silent fallback if group metadata fetch fails
          }

          conversations.set(senderNorm, {
            contactName: senderNorm,
            name: groupName,
            groupId: joinedGroupId,
            messages: [],
            isReady: true,
            mlsStateHex: null,
          });
          saveConversation(senderNorm);

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

      log('Connexion Gateway...');
      try {
        const token = await generateDevToken(userId);
        await mlsService.connect(token);
        isWsConnected = true;
        log('Connecté au réseau !');
        // Detect new own devices (added after last login) and invite them to
        // all existing groups so they can receive Welcomes automatically.
        syncOwnDevicesToGroups().catch(() => {});
      } catch (_wsErr: unknown) {
        const msg = _wsErr instanceof Error ? _wsErr.message : String(_wsErr);
        log(`Gateway inaccessible: ${msg}`);
      }

      try {
        await mlsService.generateKeyPackage(pin);
        log('KeyPackage publié.');
      } catch {
        // Silent fallback if key package generation fails
      }
    } catch (_e: unknown) {
      const msg = _e instanceof Error ? _e.message : String(_e);
      loginError = msg;
      log(`Erreur: ${loginError}`);
    } finally {
      isLoggingIn = false;
    }
  }

  // --- Utils ---
  function toHex(buffer: Uint8Array): string {
    return Array.from(buffer)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function fromHex(hex: string): Uint8Array {
    const match = hex.match(/.{1,2}/g);
    if (!match) return new Uint8Array();
    return new Uint8Array(match.map((byte) => parseInt(byte, 16)));
  }

  // --- Persistance (DB) ---

  /** Upsert conversation metadata into the persistent DB. */
  async function saveConversation(contactName: string) {
    if (!storage) return;
    const normalized = contactName.toLowerCase();
    const convo = conversations.get(normalized);
    if (!convo) return;
    await storage.saveConversation({
      id: normalized,
      groupId: convo.groupId,
      name: convo.name,
      isReady: convo.isReady,
      updatedAt: Date.now(),
    });
  }

  /** Migrate legacy localStorage conversations to the DB (run once on first login). */
  async function migrateFromLocalStorage() {
    if (!storage) return;
    const prefix = `conversation:${userId}:`;
    const keysToMigrate: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) keysToMigrate.push(key);
    }
    if (keysToMigrate.length === 0) return;

    log(`Migration de ${keysToMigrate.length} conversation(s) depuis localStorage…`);
    for (const key of keysToMigrate) {
      const saved = localStorage.getItem(key);
      if (!saved) continue;
      const contactName = key.substring(prefix.length);
      let data: any;
      try {
        data = JSON.parse(saved);
      } catch {
        continue;
      }

      await storage.saveConversation({
        id: contactName,
        groupId: data.groupId,
        name: data.name || contactName,
        isReady: data.isReady || false,
        updatedAt: Date.now(),
      });

      for (const m of (data.messages || []) as any[]) {
        try {
          await storage.saveMessage(
            {
              id: m.id || crypto.randomUUID(),
              conversationId: contactName,
              senderId: m.senderId || '',
              content: m.content || '',
              timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
            },
            pin
          );
        } catch {
          /* skip invalid rows */
        }
      }

      localStorage.removeItem(key);
    }
    log('Migration terminée ✅');
  }

  async function loadHistoryForConversation(contactName: string, groupId: string) {
    const mlsService = ensureMls();
    try {
      const history = await mlsService.fetchHistory(groupId);
      if (history.length > 0) {
        let addedMsg = 0;
        let mlsUpdated = false;

        for (const msg of history) {
          if (msg.sender_id === userId) continue;
          try {
            const bytesStr = atob(msg.content);
            const bytes = new Uint8Array(bytesStr.length);
            for (let i = 0; i < bytesStr.length; i++) bytes[i] = bytesStr.charCodeAt(i);

            const decrypted = await mlsService.processIncomingMessage(groupId, bytes);
            if (decrypted) {
              await addMessageToChat(msg.sender_id, decrypted, contactName);
              addedMsg++;
              mlsUpdated = true;
            }
          } catch {
            // Silently ignore errors in processing individual messages
          }
        }
        if (mlsUpdated) {
          const stateBytes = await mlsService.saveState(pin);
          localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));
          log(`✅ ${addedMsg} msg rattrapés pour ${contactName}.`);
        }
      }
    } catch {
      // Silently ignore errors in loading history
    }
  }

  async function loadExistingConversations() {
    if (!storage) return;

    // One-time migration from the old localStorage format
    await migrateFromLocalStorage();

    const convMetas = await storage.getConversations();
    for (const meta of convMetas) {
      const storedMessages = await storage.getMessages(meta.id, pin);
      conversations.set(meta.id, {
        contactName: meta.id,
        name: meta.name,
        groupId: meta.groupId,
        messages: storedMessages.map((m) => {
          let content = m.content;
          let replyTo: ChatMessage['replyTo'] = undefined;

          // Try to parse JSON (new format with replyTo)
          try {
            const parsed = JSON.parse(m.content);
            if (parsed.content) {
              content = parsed.content;
              replyTo = parsed.replyTo;
            }
          } catch {
            // Legacy plain text format
          }

          return {
            id: m.id,
            senderId: m.senderId,
            content,
            timestamp: new Date(m.timestamp),
            isOwn: m.senderId.toLowerCase() === userId.toLowerCase(),
            replyTo,
          };
        }),
        isReady: meta.isReady,
        mlsStateHex: null,
      });
      loadHistoryForConversation(meta.id, meta.groupId);
    }
  }

  // --- Gestion Groupes & Membres ---
  async function createNewGroup(nameRaw: string) {
    const mlsService = ensureMls();
    if (!nameRaw.trim()) return;
    const name = nameRaw.trim();
    if (conversations.has(name)) return log(`Groupe "${name}" existe déjà.`);

    try {
      const groupId = await mlsService.createRemoteGroup(name);
      await mlsService.createGroup(groupId);
      await mlsService.registerMember(groupId, userId, mlsService.getDeviceId());

      // Ajout de ses propres autres appareils (CORRIGÉ)
      const ownDevices = (await mlsService.fetchUserDevices(userId)).filter(
        (d) => d.deviceId !== mlsService.getDeviceId()
      );
      for (const device of ownDevices) {
        try {
          const result = await mlsService.addMember(groupId, device.keyPackage);
          await mlsService.registerMember(groupId, userId, device.deviceId);
          if (result.welcome) {
            await mlsService.sendWelcome(result.welcome, userId, groupId, device.deviceId);
          }
          if (result.commit) {
            await mlsService.sendCommit(result.commit, groupId);
          }
        } catch (e) {
          log(`Erreur synchro propre appareil ${device.deviceId}: ${e}`);
        }
      }

      const stateBytes = await mlsService.saveState(pin);
      localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));

      conversations.set(name, {
        contactName: name,
        name,
        groupId,
        messages: [],
        isReady: true,
        mlsStateHex: null,
      });
      selectConversation(name);
      saveConversation(name);
      log(`✅ Groupe "${name}" créé!`);
    } catch (e) {
      log(`Erreur création groupe: ${e}`);
    }
  }

  async function inviteMemberToCurrentGroup(memberId: string) {
    if (!selectedContact || !memberId.trim()) return;
    const mlsService = ensureMls();
    const targetUser = memberId.trim().toLowerCase();
    const convo = conversations.get(selectedContact);
    if (!convo) return;

    log(`Invitation de ${targetUser}...`);
    try {
      await mlsService.registerMember(convo.groupId, userId, mlsService.getDeviceId());
      const devices = await mlsService.fetchUserDevices(targetUser);
      if (devices.length === 0) return log(`❌ Aucun appareil trouvé pour ${targetUser}.`);

      // Utilisation stricte de l'ajout par lot (CORRIGÉ)
      const bulk = await mlsService.addMembersBulk(convo.groupId, devices);

      for (const did of bulk.addedDeviceIds) {
        await mlsService.registerMember(convo.groupId, targetUser, did);
      }

      const stateBytes = await mlsService.saveState(pin);
      localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));

      if (bulk.welcome) {
        const welcomeB64 = btoa(
          Array.from(bulk.welcome)
            .map((b) => String.fromCharCode(b))
            .join('')
        );
        for (const did of bulk.addedDeviceIds) {
          await fetch(`${historyBaseUrl}/mls-api/welcome`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              targetDeviceId: did,
              targetUserId: targetUser,
              senderUserId: userId,
              welcomePayload: welcomeB64,
              groupId: convo.groupId,
            }),
          });
        }
      }

      if (bulk.commit) await mlsService.sendCommit(bulk.commit, convo.groupId);

      log(`✅ ${targetUser} invité (${bulk.addedDeviceIds.length}/${devices.length} appareils).`);

      // Send control message to notify all members
      try {
        const controlMsg = JSON.stringify({ type: 'memberAdded', newUser: targetUser });
        await mlsService.sendMessage(convo.groupId, controlMsg);
        const st = await mlsService.saveState(pin);
        localStorage.setItem('mls_autosave_' + userId, toHex(st));
      } catch (e) {
        console.warn('Failed to broadcast member addition:', e);
      }
    } catch (e) {
      log(`Erreur invitation: ${e}`);
    }
  }

  async function startNewConversation(contactNameRaw: string) {
    const contact = contactNameRaw.trim().toLowerCase();
    const mlsService = ensureMls();
    if (!contact || contact === userId) return;

    if (conversations.has(contact)) {
      selectConversation(contact);
      return;
    }

    const groupName = `${userId} & ${contact}`;
    try {
      const groupId = await mlsService.createRemoteGroup(groupName);

      conversations.set(contact, {
        contactName: contact,
        name: groupName,
        groupId,
        messages: [],
        isReady: false,
        mlsStateHex: null,
      });
      selectConversation(contact);

      await mlsService.createGroup(groupId);
      await mlsService.registerMember(groupId, userId, mlsService.getDeviceId());

      // Synchro de ses autres appareils (CORRIGÉ)
      const ownDevices = (await mlsService.fetchUserDevices(userId)).filter(
        (d) => d.deviceId !== mlsService.getDeviceId()
      );
      for (const device of ownDevices) {
        try {
          const result = await mlsService.addMember(groupId, device.keyPackage);
          await mlsService.registerMember(groupId, userId, device.deviceId);
          if (result.welcome)
            await mlsService.sendWelcome(result.welcome, userId, groupId, device.deviceId);
          if (result.commit) await mlsService.sendCommit(result.commit, groupId);
        } catch {
          // Silently ignore errors in device sync
        }
      }

      const stBytes = await mlsService.saveState(pin);
      localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));

      // Ajout des appareils du contact cible (CORRIGÉ)
      const devices = await mlsService.fetchUserDevices(contact);
      if (devices.length > 0) {
        const bulk = await mlsService.addMembersBulk(groupId, devices);

        for (const did of bulk.addedDeviceIds) {
          await mlsService.registerMember(groupId, contact, did);
        }

        const st2Bytes = await mlsService.saveState(pin);
        localStorage.setItem('mls_autosave_' + userId, toHex(st2Bytes));

        if (bulk.welcome) {
          const welcomeB64 = btoa(
            Array.from(bulk.welcome)
              .map((b) => String.fromCharCode(b))
              .join('')
          );
          for (const did of bulk.addedDeviceIds) {
            await fetch(`${historyBaseUrl}/mls-api/welcome`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                targetDeviceId: did,
                targetUserId: contact,
                senderUserId: userId,
                welcomePayload: welcomeB64,
                groupId,
              }),
            });
          }
        }
        if (bulk.commit) await mlsService.sendCommit(bulk.commit, groupId);

        const convo = conversations.get(contact)!;
        conversations.set(contact, { ...convo, isReady: true });
        saveConversation(contact);
        log(`✅ Canal sécurisé avec ${contact}.`);
      } else {
        log(`❌ Appareils introuvables pour ${contact}.`);
        conversations.delete(contact);
      }
    } catch (_e: unknown) {
      const msg = _e instanceof Error ? _e.message : String(_e);
      log(`Erreur création: ${msg}`);
    }
  }

  // --- Messages & UI ---
  async function addMessageToChat(
    senderId: string,
    content: string,
    contactName: string,
    replyTo?: { id: string; senderId: string; content: string },
    isSystem = false
  ) {
    const normalized = contactName.toLowerCase();
    const convo = conversations.get(normalized);
    if (!convo) return;

    const isOwn = senderId.toLowerCase() === userId.toLowerCase();

    const newMsg: ChatMessage = {
      id: crypto.randomUUID(),
      senderId: senderId.toLowerCase(),
      content,
      timestamp: new Date(),
      isOwn,
      replyTo,
      isSystem,
    };

    conversations.set(normalized, {
      ...convo,
      messages: [...convo.messages, newMsg],
    });

    // Persist message to DB (encrypted with PIN)
    // Store as JSON to preserve replyTo metadata (skip system messages)
    if (storage && !isSystem) {
      try {
        const storageContent = JSON.stringify({ content, replyTo });
        await storage.saveMessage(
          {
            id: newMsg.id,
            conversationId: normalized,
            senderId: newMsg.senderId,
            content: storageContent,
            timestamp: newMsg.timestamp.getTime(),
          },
          pin
        );
        await saveConversation(normalized);
      } catch (e) {
        console.error('[DB] Failed to persist message:', e);
      }
    }

    tick().then(() => {
      if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
    });
  }

  async function addSystemMessage(content: string, contactName: string) {
    await addMessageToChat('system', content, contactName, undefined, true);
  }

  async function handleSendChat() {
    const text = messageText.trim();
    if (!text || !selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo?.isReady) return;

    messageText = '';
    sendError = '';

    try {
      const mlsService = ensureMls();

      // Build payload based on reply state
      let payload: string;
      let replyToData: ChatMessage['replyTo'] = undefined;

      if (replyingTo) {
        payload = JSON.stringify({
          type: 'reply',
          content: text,
          replyTo: {
            id: replyingTo.id,
            senderId: replyingTo.senderId,
            content: replyingTo.content.slice(0, 100), // preview only
          },
        });
        replyToData = {
          id: replyingTo.id,
          senderId: replyingTo.senderId,
          content: replyingTo.content.slice(0, 100),
        };
        replyingTo = null; // Clear reply state
      } else {
        payload = JSON.stringify({ type: 'text', content: text });
      }

      await mlsService.sendMessage(convo.groupId, payload);
      const stateBytes = await mlsService.saveState(pin);
      localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));
      await addMessageToChat(userId, text, selectedContact, replyToData);
    } catch (_e: unknown) {
      const msg = _e instanceof Error ? _e.message : String(_e);
      log(`Erreur envoi: ${msg}`);
      messageText = text;
      if (
        msg.includes('Groupe introuvable') ||
        msg.includes('not found') ||
        msg.includes('group')
      ) {
        sendError =
          "Tu n'es plus membre de ce groupe. Supprime-le et demande une nouvelle invitation.";
      } else {
        sendError = `Échec de l'envoi : ${msg}`;
      }
    }
  }

  async function handleAddReaction(messageId: string, emoji: string) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo?.isReady) return;

    try {
      const mlsService = ensureMls();
      const payload = JSON.stringify({ type: 'reaction', messageId, emoji });
      await mlsService.sendMessage(convo.groupId, payload);
      const stateBytes = await mlsService.saveState(pin);
      localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));

      // Update local reactions immediately
      const reactions = messageReactions.get(messageId) || [];
      const filtered = reactions.filter((r) => r.userId !== userId.toLowerCase());
      filtered.push({ emoji, userId: userId.toLowerCase() });
      messageReactions.set(messageId, filtered);
    } catch (e) {
      console.warn('Failed to send reaction:', e);
    }
  }

  function handleReply(message: ChatMessage) {
    replyingTo = message;
    // Focus composer (will be handled by ChatComposer)
  }

  function cancelReply() {
    replyingTo = null;
  }

  function _handleKeydown(_e: KeyboardEvent) {
    if (_e.key === 'Enter' && !_e.shiftKey) {
      _e.preventDefault();
      handleSendChat();
    }
  }

  function selectConversation(name: string) {
    selectedContact = name;
    mobileView = 'chat';
    sendError = '';
    // Load member list for the selected group
    const convo = conversations.get(name);
    if (convo?.groupId) loadGroupMembers(convo.groupId);
  }

  async function loadGroupMembers(groupId: string) {
    try {
      const mlsService = ensureMls();
      const members = await mlsService.getGroupMembers(groupId);
      // Deduplicate by userId (a user may have multiple devices)
      const uniqueUsers = [...new Set(members.map((m) => m.userId))];
      groupMembers = uniqueUsers;
    } catch (e) {
      console.warn('[GroupMembers]', e);
      groupMembers = [];
    }
  }

  async function handleRenameGroup(name: string) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    try {
      const mlsService = ensureMls();
      await mlsService.renameGroup(convo.groupId, name);
      conversations.set(selectedContact, { ...convo, name });
      if (storage) await saveConversation(selectedContact);
      log(`Groupe renommé en "${name}"`);

      // Send control message to propagate rename to all group members
      try {
        const controlMsg = JSON.stringify({ type: 'groupRenamed', newName: name });
        await mlsService.sendMessage(convo.groupId, controlMsg);
        const stBytes = await mlsService.saveState(pin);
        localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));
      } catch (e) {
        console.warn('Failed to broadcast rename:', e);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Erreur renommage: ${msg}`);
    }
  }

  async function handleDeleteGroup() {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    try {
      const mlsService = ensureMls();
      await mlsService.deleteGroupOnServer(convo.groupId);
      if (storage) await storage.deleteConversation(selectedContact);
      conversations.delete(selectedContact);
      selectedContact = null;
      mobileView = 'list';
      groupMembers = [];
      log(`Groupe "${convo.name}" supprimé.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Erreur suppression groupe: ${msg}`);
    }
  }

  async function handleRemoveMember(memberId: string) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    try {
      const mlsService = ensureMls();
      await mlsService.removeMemberFromServer(convo.groupId, memberId);
      groupMembers = groupMembers.filter((m) => m !== memberId);
      log(`${memberId} retiré du groupe.`);

      // Send control message to notify all members
      try {
        const controlMsg = JSON.stringify({ type: 'memberRemoved', targetUser: memberId });
        await mlsService.sendMessage(convo.groupId, controlMsg);
        const stBytes = await mlsService.saveState(pin);
        localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));
      } catch (e) {
        console.warn('Failed to broadcast member removal:', e);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Erreur retrait membre: ${msg}`);
    }
  }

  function goBackToMenu() {
    mobileView = 'list';
  }

  function logout() {
    isLoggedIn = false;
    isWsConnected = false;
    conversations.clear();
    selectedContact = null;
    statusLog = [];
    storage = null;
    groupMembers = [];
    sendError = '';
    localStorage.removeItem('canari_saved_user');
    localStorage.removeItem('canari_saved_pin');
  }

  async function resetAll() {
    if (storage) {
      await storage.clear();
      storage = null;
    }
    localStorage.clear();
    logout();
  }

  // --- Sauvegarde (export / import WhatsApp-style) ---

  /**
   * Run on every connect: fetch this user's own registered devices and, for
   * any that are new (not yet in the local cache), add them to each existing
   * MLS group and send them the resulting Welcome.
   *
   * A device is considered "new" when its deviceId is absent from the
   * `known_own_devices:<userId>` key in localStorage.  This avoids redundant
   * `addMember` calls on every login for devices already synced.
   *
   * Device B (the importing device) cannot invite itself – it has no group
   * state yet.  It must wait for Device A to run this function and deliver
   * Welcomes, after which the existing `onMessage → processWelcome` path
   * handles everything automatically.
   */
  async function syncOwnDevicesToGroups() {
    const mlsService = ensureMls();

    let allOwnDevices: { keyPackage: Uint8Array; deviceId: string }[];
    try {
      allOwnDevices = (await mlsService.fetchUserDevices(userId)).filter(
        (d) => d.deviceId !== mlsService.getDeviceId()
      );
    } catch {
      return;
    }
    if (allOwnDevices.length === 0) return;

    // Cache of device IDs we've already fully synced (all groups attempted).
    const cacheKey = `known_own_devices:${userId}`;
    let knownIds: SvelteSet<string>;
    try {
      knownIds = new SvelteSet(JSON.parse(localStorage.getItem(cacheKey) ?? '[]'));
    } catch {
      knownIds = new SvelteSet();
    }

    const newDevices = allOwnDevices.filter((d) => !knownIds.has(d.deviceId));
    if (newDevices.length === 0) return;

    log(`🔄 Nouvel(s) appareil(s) détecté(s) : synchronisation en cours…`);
    let totalWelcomes = 0;

    for (const device of newDevices) {
      let allOk = true;
      for (const [, convo] of conversations.entries()) {
        if (!convo.isReady) continue;
        try {
          const result = await mlsService.addMember(convo.groupId, device.keyPackage);
          await mlsService.registerMember(convo.groupId, userId, device.deviceId);
          if (result.welcome) {
            await mlsService.sendWelcome(result.welcome, userId, convo.groupId, device.deviceId);
            totalWelcomes++;
          }
          if (result.commit) {
            await mlsService.sendCommit(result.commit, convo.groupId);
          }
          const stBytes = await mlsService.saveState(pin);
          localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));
        } catch {
          // Device might already be in the group, or key package was already
          // consumed – skip silently.  Don't mark as known so we retry next
          // time in case it was a transient error.
          allOk = false;
        }
      }
      if (allOk) {
        knownIds.add(device.deviceId);
        localStorage.setItem(cacheKey, JSON.stringify([...knownIds]));
      }
    }

    if (totalWelcomes > 0) {
      log(`✅ ${totalWelcomes} Welcome(s) envoyé(s) aux nouveaux appareils.`);
    }
  }

  async function handleExport() {
    if (!storage) return;
    isExporting = true;
    try {
      const mlsStateHex = localStorage.getItem('mls_autosave_' + userId) ?? undefined;
      const blob = await exportBackup(storage, userId, pin, myDeviceId, mlsStateHex);
      const date = new Date().toISOString().split('T')[0];
      const filename = `canari-backup-${userId}-${date}.canari`;

      // Works in both browser and Tauri WebView
      const url = URL.createObjectURL(
        new Blob([blob.buffer as ArrayBuffer], { type: 'application/octet-stream' })
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      log(`✅ Sauvegarde exportée : ${filename}`);
    } catch (e) {
      log(`Erreur export : ${e}`);
    } finally {
      isExporting = false;
    }
  }

  async function handleImport(file: File) {
    if (!storage) return;
    isImporting = true;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const { data: backup, isSameDevice } = await importBackup(
        new Uint8Array(arrayBuffer),
        pin,
        storage,
        myDeviceId
      );

      if (isSameDevice) {
        // Same physical device (wipe + restore): the MLS state blob is valid
        // for this device's leaf keypair – restore it unconditionally.
        const existingMlsState = localStorage.getItem('mls_autosave_' + userId);
        if (backup.mlsState && !existingMlsState) {
          localStorage.setItem('mls_autosave_' + userId, backup.mlsState);
          log('État MLS restauré (même appareil).');
        } else if (existingMlsState) {
          log('État MLS local conservé (appareil déjà actif).');
        }
      } else {
        // Different device: the MLS state blob belongs to the exporter's leaf
        // keypair – applying it here would corrupt or impersonate that identity.
        // Conversations were imported with isReady=false; this device must wait
        // for the original device to call syncOwnDevicesToGroups() and deliver
        // a Welcome for each group.
        log(
          '⚠️ Nouvel appareil détecté. Les conversations sont importées en lecture seule. ' +
            "Reconnectez l'appareil exportateur pour déclencher l'invitation automatique aux groupes."
        );
        // Clear the known-devices cache on the exporter side so it will re-sync
        // when it comes online (transparent to this device, but good hygiene).
      }

      // Reload conversations from the freshly populated DB
      conversations.clear();
      await loadExistingConversations();

      log(
        `✅ Sauvegarde importée : ${backup.conversations.length} conversation(s), ` +
          `${backup.messages.length} message(s).`
      );
    } catch (e) {
      log(`Erreur import : ${e}`);
    } finally {
      isImporting = false;
    }
  }

  // --- Outils Dev ---
  async function devGenerateKeyPackage() {
    try {
      const mlsService = ensureMls();
      const bytes = await mlsService.generateKeyPackage(pin);
      lastKeyPackage = toHex(bytes);
    } catch (_e: unknown) {
      const msg = _e instanceof Error ? _e.message : String(_e);
      log(`Err GenKeyPackage: ${msg}`);
    }
  }
  async function devAddMember() {
    if (!selectedContact || !incomingBytesHex) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    try {
      const mlsService = ensureMls();
      const result = await mlsService.addMember(convo.groupId, fromHex(incomingBytesHex));
      lastCommit = toHex(result.commit);
      if (result.welcome) lastWelcome = toHex(result.welcome);
      incomingBytesHex = '';
    } catch (_e: unknown) {
      const msg = _e instanceof Error ? _e.message : String(_e);
      log(`Err AddMember: ${msg}`);
    }
  }
  async function devProcessWelcome() {
    if (!incomingBytesHex) return;
    try {
      const mlsService = ensureMls();
      await mlsService.processWelcome(fromHex(incomingBytesHex));
      incomingBytesHex = '';
    } catch (_e: unknown) {
      const msg = _e instanceof Error ? _e.message : String(_e);
      log(`Err ProcessWelcome: ${msg}`);
    }
  }
</script>

<!-- ==================== UI ==================== -->

{#if !isLoggedIn}
  <LoginForm
    {userId}
    {pin}
    {isLoggingIn}
    {loginError}
    onUserIdChange={(value) => (userId = value)}
    onPinChange={(value) => (pin = value)}
    onLogin={handleLogin}
    onReset={resetAll}
  />
{:else}
  <div class="app-layout" in:fade>
    <Navbar {isWsConnected} onToggleLogs={() => (showLogs = !showLogs)} onLogout={logout} />

    <!-- CONTENT -->
    <main class="main-content">
      <Sidebar
        {conversations}
        {selectedContact}
        {newContactInput}
        {newGroupInput}
        onContactInputChange={(value) => (newContactInput = value)}
        onGroupInputChange={(value) => (newGroupInput = value)}
        onAddContact={() => {
          if (newContactInput.trim()) {
            startNewConversation(newContactInput);
            newContactInput = '';
          }
        }}
        onCreateGroup={() => {
          if (newGroupInput.trim()) {
            createNewGroup(newGroupInput);
            newGroupInput = '';
          }
        }}
        onSelectConversation={selectConversation}
        onExport={handleExport}
        onImport={handleImport}
        {isExporting}
        {isImporting}
        isHidden={mobileView === 'chat'}
      />

      <ChatArea
        conversation={currentConvo}
        {messageText}
        {inviteMemberInput}
        onMessageChange={(value) => (messageText = value)}
        onInviteInputChange={(value) => (inviteMemberInput = value)}
        onSend={handleSendChat}
        onInviteMember={() => {
          if (inviteMemberInput.trim()) {
            inviteMemberToCurrentGroup(inviteMemberInput);
            inviteMemberInput = '';
          }
        }}
        onBack={goBackToMenu}
        isHidden={mobileView === 'list'}
        {groupMembers}
        {sendError}
        onGroupRename={handleRenameGroup}
        onGroupDelete={handleDeleteGroup}
        onGroupRemoveMember={handleRemoveMember}
        {messageReactions}
        {replyingTo}
        onReply={handleReply}
        onReact={handleAddReaction}
        onCancelReply={cancelReply}
      />

      {#if showLogs}
        <LogsPanel
          logs={statusLog}
          onClose={() => (showLogs = false)}
          onGenerateKeyPackage={devGenerateKeyPackage}
          onAddMember={devAddMember}
          onProcessWelcome={devProcessWelcome}
          {lastKeyPackage}
          {lastCommit}
          {lastWelcome}
          {incomingBytesHex}
          onIncomingBytesChange={(value) => (incomingBytesHex = value)}
        />
      {/if}
    </main>
  </div>
{/if}

<style>
  .app-layout {
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .main-content {
    display: flex;
    flex: 1;
    overflow: hidden;
  }
</style>
