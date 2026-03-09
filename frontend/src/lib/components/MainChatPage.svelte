<script lang="ts">
  import { TauriMlsService, WebMlsService } from '$lib/mlsService';
  import type { IMlsService } from '$lib/mlsService';
  import { getStorage } from '$lib/db';
  import type { IStorage } from '$lib/db';
  import { onMount, tick, untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { fade } from 'svelte/transition';
  import { fromHex, toHex } from '$lib/utils/hex';
  import { computePinVerifier, generateDevToken } from '$lib/utils/mainChatAuth';
  import {
    addDevMember,
    exportUserBackup,
    generateDevKeyPackage,
    importUserBackup,
    processDevWelcome,
    syncOwnDevicesToGroups,
  } from '$lib/utils/mainChatActions';
  import {
    deleteGroupAndBroadcast,
    fetchUniqueGroupMembers,
    removeMemberAndBroadcast,
    renameGroupAndBroadcast,
  } from '$lib/utils/mainChatGroupActions';
  import {
    mapStoredMessagesToChatMessages,
    replayConversationHistory,
  } from '$lib/utils/mainChatHistory';
  import { setupMessageHandler, initializeConnection } from '$lib/utils/mainChatConnection';
  import {
    createNewGroup as createGroup,
    inviteMemberToGroup,
    startNewConversation as startConversation,
  } from '$lib/utils/mainChatGroupCreation';
  import {
    sendChatMessage,
    addReaction,
    editMessage,
    deleteMessage,
    sendReadReceipt,
  } from '$lib/utils/mainChatMessaging';
  import { migrateFromLocalStorage } from '$lib/utils/migration';
  import { MediaService } from '$lib/media';
  import { encodeAppMessage, mkMedia, MediaKind } from '$lib/proto/codec';
  import LoginForm from './LoginForm.svelte';
  import Navbar from './Navbar.svelte';
  import Sidebar from './Sidebar.svelte';
  import ChatArea from './ChatArea.svelte';
  import LogsPanel from './LogsPanel.svelte';
  import type { ChatMessage, MessageReaction, Conversation } from '$lib/types';

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
  let messageText = $state('');
  let chatContainer = $state<HTMLElement>();

  let isWsConnected = $state(false);
  let myDeviceId = $state('');

  // Reconnection
  const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let isReconnecting = false; // guard against concurrent reconnect attempts
  let isSyncing = false; // guard against concurrent device-sync storms

  // Variables de débogage
  let lastKeyPackage = $state('');
  let incomingBytesHex = $state('');
  let lastCommit = $state('');
  let lastWelcome = $state('');

  // Valeurs dérivées pour rendu réactif
  let currentConvo = $derived(
    selectedContact ? (conversations.get(selectedContact) ?? null) : null
  );

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

  // Media
  const mediaService = new MediaService();
  const mediaMaxSizeMb = Number.parseInt(import.meta.env.VITE_MEDIA_MAX_SIZE_MB ?? '50', 10);
  const mediaMaxSizeBytes = mediaMaxSizeMb * 1024 * 1024;
  let authToken = $state('');
  let pendingMediaFile = $state<File | null>(null);
  let isUploadingMedia = $state(false);

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

  // Read Receipts logic
  $effect(() => {
    if (!selectedContact || !isLoggedIn) return;
    const convo = conversations.get(selectedContact);
    if (!convo || !convo.isReady) return;

    // Find messages we haven't read
    const meNorm = userId.toLowerCase();
    const unread = convo.messages.filter(
      (m) => !m.isOwn && !m.isSystem && !(m.readBy || []).includes(meNorm)
    );
    if (unread.length === 0) return;

    const ids = unread.map((m) => m.id);
    const currentContact = selectedContact;

    // Mark as read IMMEDIATELY (synchronously, untracked) so any subsequent
    // re-run of this effect sees them as already read and doesn't re-send.
    untrack(() => {
      const freshConvo = conversations.get(currentContact);
      if (!freshConvo) return;
      const newMsgs = freshConvo.messages.map((m) =>
        ids.includes(m.id) ? { ...m, readBy: [...(m.readBy || []), meNorm] } : m
      );
      conversations.set(currentContact, { ...freshConvo, messages: newMsgs });
    });

    // Then send the receipt over the wire (best-effort, no retry needed
    // because the optimistic update already prevents duplicate sends).
    try {
      const mlsService = ensureMls();
      sendReadReceipt(ids, {
        mlsService,
        userId,
        pin,
        conversation: convo,
      }).catch(() => {
        // Silently ignore — the local state is already updated.
      });
    } catch {
      // MLS not ready yet, will catch next time.
    }
  });

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

    // Reconnexion automatique quand la page redevient visible (mobile/onglets)
    // Les navigateurs mobiles ferment le WebSocket quand l'app est mise en arrière-plan.
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isLoggedIn && !isWsConnected) {
        log('Page visible de nouveau — reconnexion…');
        // Cancel any pending timer so we don't reconnect twice
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        void attemptReconnect();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  });

  function log(msg: string) {
    statusLog = [...statusLog, `[${new Date().toLocaleTimeString()}] ${msg}`];
    tick().then(() => {
      const logEl = document.getElementById('logContainer');
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    });
  }

  // --- Auth & Initialisation ---

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

      // Verify PIN consistency across devices before doing anything else
      log('Vérification du PIN...');
      const verifier = await computePinVerifier(userId, pin);
      const verifierRes = await fetch(`${historyBaseUrl}/mls-api/pin-verifier/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, verifier }),
      });
      if (!verifierRes.ok) throw new Error('Impossible de vérifier le PIN (serveur inaccessible).');
      const verifierData = await verifierRes.json();
      if (verifierData.status === 'mismatch') {
        throw new Error(
          'PIN incorrect : ce PIN ne correspond pas à celui enregistré pour cet utilisateur. Tous vos appareils doivent utiliser le même PIN.'
        );
      }
      if (verifierData.status === 'registered') {
        log('Premier appareil : PIN enregistré.');
      }

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

      // Setup message handler
      setupMessageHandler({
        mlsService,
        storage,
        userId,
        pin,
        historyBaseUrl,
        conversations,
        messageReactions,
        selectedContact,
        setSelectedContact: (value) => (selectedContact = value),
        setMobileView: (value) => (mobileView = value),
        saveConversation,
        addMessageToChat,
        addSystemMessage,
        loadHistoryForConversation,
        log,
      });

      authToken = await generateDevToken(
        userId,
        import.meta.env.VITE_JWT_SECRET,
        import.meta.env.DEV
      );

      // Initialize WebSocket connection
      await initializeConnection({
        mlsService,
        userId,
        pin,
        jwtSecret: import.meta.env.VITE_JWT_SECRET,
        isDev: import.meta.env.DEV,
        scheduleReconnect,
        setIsWsConnected: (value) => (isWsConnected = value),
        setReconnectAttempts: (value) => (reconnectAttempts = value),
        syncOwnDevicesToGroupsLocally,
        log,
      });
    } catch (_e: unknown) {
      const msg = _e instanceof Error ? _e.message : String(_e);
      loginError = msg;
      log(`Erreur: ${loginError}`);
    } finally {
      isLoggingIn = false;
    }
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
  // --- History Sync ---

  async function loadHistoryForConversation(contactName: string, groupId: string) {
    const mlsService = ensureMls();
    await replayConversationHistory({
      mlsService,
      groupId,
      contactName,
      userId,
      pin,
      addMessageToChat,
      log,
    });
  }

  async function loadExistingConversations() {
    if (!storage) return;

    // One-time migration from the old localStorage format
    await migrateFromLocalStorage(userId, pin, storage, log);

    const convMetas = await storage.getConversations();

    // Phase 1 (fast, blocking): populate the conversations map with metadata
    // only so the WS message handler can route messages immediately.
    for (const meta of convMetas) {
      conversations.set(meta.id, {
        contactName: meta.id,
        name: meta.name,
        groupId: meta.groupId,
        messages: [], // loaded asynchronously in phase 2
        isReady: meta.isReady,
        mlsStateHex: null,
      });
    }

    // Phase 2 (background, non-blocking): decrypt stored messages and replay
    // remote history. Run all conversations in parallel so decryption doesn't
    // serialize across conversations.
    for (const meta of convMetas) {
      storage
        .getMessages(meta.id, pin)
        .then((storedMessages) => {
          const msgs = mapStoredMessagesToChatMessages(storedMessages, userId);
          const existing = conversations.get(meta.id);
          // Only inject if no live messages arrived in the meantime
          if (existing && existing.messages.length === 0 && msgs.length > 0) {
            conversations.set(meta.id, { ...existing, messages: msgs });
          }
        })
        .catch(() => {});
      loadHistoryForConversation(meta.id, meta.groupId);
    }
  }

  // --- Gestion Groupes & Membres ---
  async function createNewGroup(nameRaw: string) {
    const mlsService = ensureMls();
    await createGroup(nameRaw, {
      mlsService,
      storage,
      userId,
      pin,
      historyBaseUrl,
      conversations,
      selectConversation,
      saveConversation,
      log,
    });
  }

  async function inviteMemberToCurrentGroup(memberId: string) {
    if (!selectedContact) return;
    const mlsService = ensureMls();
    const convo = conversations.get(selectedContact);
    if (!convo) return;

    await inviteMemberToGroup(memberId, convo, {
      mlsService,
      storage,
      userId,
      pin,
      historyBaseUrl,
      conversations,
      selectConversation,
      saveConversation,
      log,
    });
  }

  async function startNewConversation(contactNameRaw: string) {
    const mlsService = ensureMls();
    await startConversation(contactNameRaw, {
      mlsService,
      storage,
      userId,
      pin,
      historyBaseUrl,
      conversations,
      selectConversation,
      saveConversation,
      log,
    });
  }

  // --- Messages & UI ---
  async function addMessageToChat(
    senderId: string,
    content: string,
    contactName: string,
    replyTo?: { id: string; senderId: string; content: string },
    isSystem = false,
    messageId?: string
  ) {
    const normalized = contactName.toLowerCase();
    const convo = conversations.get(normalized);
    if (!convo) return;

    const isOwn = senderId.toLowerCase() === userId.toLowerCase();

    const newMsg: ChatMessage = {
      id: messageId || crypto.randomUUID(),
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
    const fileToSend = pendingMediaFile;

    if (!text && !fileToSend) return;
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;

    const currentReplyingTo = replyingTo;
    if (text) messageText = '';
    replyingTo = null;
    sendError = '';

    const mlsService = ensureMls();

    if (fileToSend) {
      pendingMediaFile = null;
      isUploadingMedia = true;
      try {
        if (!authToken) {
          authToken = await generateDevToken(
            userId,
            import.meta.env.VITE_JWT_SECRET,
            import.meta.env.DEV
          );
        }
        const mediaRef = await mediaService.encryptAndUpload(fileToSend, authToken);
        const messageId = crypto.randomUUID();
        // Encode as proto AppMessage for MLS encryption
        const kindMap: Record<string, number> = {
          image: MediaKind.MEDIA_IMAGE,
          video: MediaKind.MEDIA_VIDEO,
          audio: MediaKind.MEDIA_AUDIO,
          file: MediaKind.MEDIA_FILE,
        };
        const keyBytes = new Uint8Array(
          (mediaRef.key.match(/.{1,2}/g) ?? []).map((b) => parseInt(b, 16))
        );
        const ivBytes = new Uint8Array(
          (mediaRef.iv.match(/.{1,2}/g) ?? []).map((b) => parseInt(b, 16))
        );
        const protoBytes = encodeAppMessage({
          ...mkMedia({
            kind: kindMap[mediaRef.type] ?? MediaKind.MEDIA_FILE,
            mediaId: mediaRef.mediaId,
            key: keyBytes,
            iv: ivBytes,
            mimeType: mediaRef.mimeType,
            size: mediaRef.size,
            fileName: mediaRef.fileName ?? '',
          }),
          messageId,
        });
        await mlsService.sendMessage(convo.groupId, protoBytes);
        const stateBytes = await mlsService.saveState(pin);
        localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));
        // Store as JSON locally for the media renderer
        const payload = JSON.stringify({ ...mediaRef, id: messageId });
        await addMessageToChat(userId, payload, selectedContact, undefined, false, messageId);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        pendingMediaFile = fileToSend;
        sendError = `Échec de l'envoi du média : ${errorMessage}`;
        log(`Erreur envoi média: ${errorMessage}`);
      } finally {
        isUploadingMedia = false;
      }
    }

    if (!text) return;

    const result = await sendChatMessage(text, selectedContact, currentReplyingTo, {
      mlsService,
      userId,
      pin,
      conversation: convo,
      addMessageToChat,
      log,
    });

    if (!result.success) {
      messageText = text;
      replyingTo = currentReplyingTo;
      sendError = result.error || "Échec de l'envoi";
    }
  }

  async function handleFileSelected(file: File) {
    if (Number.isFinite(mediaMaxSizeBytes) && file.size > mediaMaxSizeBytes) {
      const errorMessage = `Fichier trop volumineux (${(file.size / 1024 / 1024).toFixed(1)} Mo). Limite: ${mediaMaxSizeMb} Mo.`;
      sendError = errorMessage;
      log(`Erreur envoi média: ${errorMessage}`);
      return;
    }

    // Compress images automatically
    let processedFile = file;
    if (file.type.startsWith('image/')) {
      try {
        const { compressImage } = await import('$lib/media');
        const originalSize = file.size;
        processedFile = await compressImage(file);
        if (processedFile.size < originalSize) {
          const savedPercent = ((1 - processedFile.size / originalSize) * 100).toFixed(0);
          log(
            `Image compressée: ${(originalSize / 1024 / 1024).toFixed(1)} Mo → ${(processedFile.size / 1024 / 1024).toFixed(1)} Mo (-${savedPercent}%)`
          );
        }
      } catch (e) {
        console.warn('Compression failed, using original:', e);
      }
    }

    pendingMediaFile = processedFile;
    void handleSendChat();
  }

  async function handleAddReaction(messageId: string, emoji: string) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;

    // Optimistic local update: l'expéditeur ne peut pas déchiffrer
    // son propre message MLS (CannotDecryptOwnMessage), donc on met
    // à jour immédiatement sans attendre le retour du gateway.
    const meNorm = userId.toLowerCase();
    const existing = messageReactions.get(messageId) ?? [];
    const updated = existing.filter((r) => r.userId !== meNorm);
    updated.push({ emoji, userId: meNorm });
    messageReactions.set(messageId, updated);

    const mlsService = ensureMls();
    await addReaction(messageId, emoji, {
      mlsService,
      userId,
      pin,
      conversation: convo,
    });
  }

  async function handleDeleteMessage(messageId: string) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;

    const mlsService = ensureMls();
    await deleteMessage(messageId, {
      mlsService,
      userId,
      pin,
      conversation: convo,
    });

    // Update locally
    const newMsgs = [...convo.messages];
    const idx = newMsgs.findIndex((m) => m.id === messageId);
    if (idx !== -1) {
      newMsgs[idx] = { ...newMsgs[idx], isDeleted: true, content: 'Ce message a été supprimé.' };
      conversations.set(selectedContact, { ...convo, messages: newMsgs });
      // TODO: update in local storage if needed
    }
  }

  async function handleEditMessage(messageId: string, text: string) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;

    const mlsService = ensureMls();
    await editMessage(messageId, text, {
      mlsService,
      userId,
      pin,
      conversation: convo,
    });

    // Update locally
    const newMsgs = [...convo.messages];
    const idx = newMsgs.findIndex((m) => m.id === messageId);
    if (idx !== -1) {
      newMsgs[idx] = { ...newMsgs[idx], isEdited: true, content: text, readBy: [] };
      conversations.set(selectedContact, { ...convo, messages: newMsgs });
      // TODO: update in local storage if needed
    }
  }

  function handleReply(message: ChatMessage) {
    replyingTo = message;
    // Focus composer (will be handled by ChatComposer)
  }

  function cancelReply() {
    replyingTo = null;
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
      groupMembers = await fetchUniqueGroupMembers(mlsService, groupId);
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
      await renameGroupAndBroadcast({
        mlsService,
        groupId: convo.groupId,
        newName: name,
        userId,
        pin,
      });
      conversations.set(selectedContact, { ...convo, name });
      if (storage) await saveConversation(selectedContact);
      log(`Groupe renommé en "${name}"`);
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
      await deleteGroupAndBroadcast({ mlsService, groupId: convo.groupId });
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
      await removeMemberAndBroadcast({
        mlsService,
        groupId: convo.groupId,
        memberId,
        userId,
        pin,
      });
      groupMembers = groupMembers.filter((m) => m !== memberId);
      log(`${memberId} retiré du groupe.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Erreur retrait membre: ${msg}`);
    }
  }

  function goBackToMenu() {
    mobileView = 'list';
  }

  function scheduleReconnect() {
    if (!isLoggedIn) return;
    isWsConnected = false;
    if (reconnectTimer !== null) return; // already scheduled
    if (isReconnecting) return; // already in progress
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)];
    reconnectAttempts++;
    log(
      `Connexion perdue. Nouvelle tentative dans ${delay / 1000}s… (tentative ${reconnectAttempts})`
    );
    reconnectTimer = setTimeout(attemptReconnect, delay);
  }

  async function attemptReconnect() {
    reconnectTimer = null;
    if (!isLoggedIn) return;
    if (isReconnecting) return; // prevent concurrent reconnect storms
    isReconnecting = true;
    try {
      log('Reconnexion en cours…');
      const token = await generateDevToken(
        userId,
        import.meta.env.VITE_JWT_SECRET,
        import.meta.env.DEV
      );
      const mlsService = ensureMls();
      await mlsService.connect(token);
      // Re-register disconnect handler after each successful reconnection
      mlsService.onDisconnect(scheduleReconnect);
      isWsConnected = true;
      reconnectAttempts = 0;
      log('✅ Reconnecté au réseau !');
      syncOwnDevicesToGroupsLocally().catch(() => {});
    } catch {
      scheduleReconnect();
    } finally {
      isReconnecting = false;
    }
  }

  function logout() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
    isLoggedIn = false;
    isWsConnected = false;
    conversations.clear();
    selectedContact = null;
    statusLog = [];
    storage = null;
    authToken = '';
    pendingMediaFile = null;
    isUploadingMedia = false;
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
    // Delete all CanariDB_* IndexedDB databases so no trace remains after a reset.
    if (!(window as any).__TAURI_INTERNALS__) {
      const allDbs = await indexedDB.databases();
      await Promise.all(
        allDbs
          .filter((db) => db.name?.startsWith('CanariDB'))
          .map(
            (db) =>
              new Promise<void>((resolve) => {
                const req = indexedDB.deleteDatabase(db.name!);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
              })
          )
      );
    }
    localStorage.clear();
    logout();
  }

  // --- Sauvegarde (export / import WhatsApp-style) ---

  async function syncOwnDevicesToGroupsLocally() {
    if (isSyncing) return; // prevent concurrent sync storms
    isSyncing = true;
    try {
      const mlsService = ensureMls();
      await syncOwnDevicesToGroups({
        mlsService,
        userId,
        pin,
        conversations,
        log,
      });
    } finally {
      isSyncing = false;
    }
  }

  async function handleExport() {
    if (!storage) return;
    isExporting = true;
    try {
      await exportUserBackup({
        storage,
        userId,
        pin,
        myDeviceId,
        log,
      });
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
      await importUserBackup({
        file,
        pin,
        storage,
        myDeviceId,
        userId,
        log,
        clearConversations: () => conversations.clear(),
        reloadConversations: loadExistingConversations,
      });
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
      lastKeyPackage = await generateDevKeyPackage({ mlsService, pin });
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
      const result = await addDevMember({
        mlsService,
        groupId: convo.groupId,
        incomingBytesHex,
      });
      lastCommit = result.commitHex;
      if (result.welcomeHex) lastWelcome = result.welcomeHex;
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
      await processDevWelcome({ mlsService, incomingBytesHex });
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
        onDelete={handleDeleteMessage}
        onEdit={handleEditMessage}
        onCancelReply={cancelReply}
        {authToken}
        onFileSelected={handleFileSelected}
        isUploading={isUploadingMedia}
      />

      {#if showLogs}
        <!-- Sur mobile : overlay plein écran. Sur desktop : panneau latéral dans la flexrow. -->
        <div class="fixed inset-0 z-50 flex flex-col md:relative md:inset-auto md:z-auto md:block">
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
        </div>
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
