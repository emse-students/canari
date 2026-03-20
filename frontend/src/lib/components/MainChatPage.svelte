<script lang="ts">
  import { goto } from '$app/navigation';
  import { TauriMlsService, WebMlsService } from '$lib/mlsService';
  import type { IMlsService } from '$lib/mlsService';
  import { getStorage } from '$lib/db';
  import type { IStorage, ConversationMeta, StoredMessage } from '$lib/db';
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
    fetchUniqueGroupMembers,
    removeMemberAndBroadcast,
    renameGroupAndBroadcast,
  } from '$lib/utils/mainChatGroupActions';
  import {
    mapStoredMessagesToChatMessages,
    replayConversationHistory,
  } from '$lib/utils/mainChatHistory';
  import {
    encodeSyncQrPayload,
    executeBidirectionalSyncRound,
    generateEphemeralPublicKey,
    getSyncSessionState,
    joinSyncSession,
    parseSyncQrPayload,
    startSyncSession,
  } from '$lib/sync/syncEngine';
  import { setupMessageHandler, initializeConnection } from '$lib/utils/mainChatConnection';
  import {
    createNewGroup as createGroup,
    inviteMembersToGroup,
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
  import { getPreviewText, mkMediaEnvelope, parseEnvelope, serializeEnvelope } from '$lib/envelope';
  import { encodeAppMessage, mkMedia, MediaKind } from '$lib/proto/codec';
  import { createSyncQrDataUrl } from '$lib/sync/qr';
  import LoginForm from './LoginForm.svelte';
  import { BiometricService } from '$lib/services/biometric';
  import Modal from './Modal.svelte';
  import Navbar from './Navbar.svelte';
  import Sidebar from './Sidebar.svelte';
  import ChannelPermissionsPanel from './chat/ChannelPermissionsPanel.svelte';
  import SyncSessionModal from './SyncSessionModal.svelte';
  import ChatArea from './ChatArea.svelte';
  import LogsPanel from './LogsPanel.svelte';
  import type { ChatMessage, MessageReaction, Conversation } from '$lib/types';
  import { ChannelService, type WorkspaceDto } from '$lib/services/ChannelService';

  interface ChannelSidebarItem {
    id: string;
    name: string;
    unreadCount?: number;
    isPrivate?: boolean;
  }

  interface ChannelSidebarWorkspace {
    id: string;
    name: string;
    workspaceDbId?: string;
    avatarUserId: string;
    channels: ChannelSidebarItem[];
  }

  interface Props {
    routeMode?: 'chat' | 'login';
  }

  let { routeMode = 'chat' }: Props = $props();

  // --- State (Runes) ---
  let userId = $state('');
  let pin = $state('');
  let isLoggedIn = $state(false);
  let isLoggingIn = $state(false);
  let loginError = $state('');
  // Biometric state — only meaningful on Tauri (mobile)
  let biometricAvailable = $state(false);
  let showBiometricEnrollPrompt = $state(false);
  let statusLog = $state<string[]>([]);
  let showLogs = $state(false);

  let conversations = new SvelteMap<string, Conversation>();
  let selectedContact = $state<string | null>(null);
  let mobileView = $state<'list' | 'chat'>('list'); // Gestion responsive
  let isConversationDrawerOpen = $state(false);

  let newContactInput = $state('');
  let newGroupInput = $state('');
  let newChannelInput = $state('');
  let messageText = $state('');
  let chatContainer = $state<HTMLElement>();
  let archivedConversationIds = $state<string[]>([]);
  let showArchivedConversations = $state(false);

  const channelService = new ChannelService();
  const DEFAULT_WORKSPACE_SLUG = 'asso';
  const DEFAULT_WORKSPACE_NAME = 'Asso';
  let selectedChannelConversationId = $state('');
  let channelWorkspaces = $state<ChannelSidebarWorkspace[]>([
    {
      id: DEFAULT_WORKSPACE_SLUG,
      name: DEFAULT_WORKSPACE_NAME,
      avatarUserId: DEFAULT_WORKSPACE_SLUG,
      channels: [],
    },
  ]);

  function slugifyWorkspace(name: string) {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  }

  function upsertWorkspaceFromDto(workspace: WorkspaceDto): ChannelSidebarWorkspace {
    const workspaceSlug = workspace.slug?.trim().toLowerCase() || DEFAULT_WORKSPACE_SLUG;
    const existing = channelWorkspaces.find((item) => item.id === workspaceSlug);
    if (existing) {
      existing.workspaceDbId = workspace.id ?? workspace._id;
      existing.name = workspace.name;
      if (!existing.avatarUserId) {
        existing.avatarUserId = userId || workspaceSlug;
      }
      channelWorkspaces = [...channelWorkspaces];
      return existing;
    }

    const created: ChannelSidebarWorkspace = {
      id: workspaceSlug,
      name: workspace.name,
      workspaceDbId: workspace.id ?? workspace._id,
      avatarUserId: userId || workspaceSlug,
      channels: [],
    };
    channelWorkspaces = [...channelWorkspaces, created];
    return created;
  }

  function addChannelToWorkspace(workspaceSlug: string, channel: ChannelSidebarItem) {
    const idx = channelWorkspaces.findIndex((item) => item.id === workspaceSlug);
    if (idx === -1) return;

    const workspace = channelWorkspaces[idx];
    if (workspace.channels.some((item) => item.id === channel.id)) {
      return;
    }

    const updatedWorkspace: ChannelSidebarWorkspace = {
      ...workspace,
      channels: [...workspace.channels, channel],
    };
    channelWorkspaces = [
      ...channelWorkspaces.slice(0, idx),
      updatedWorkspace,
      ...channelWorkspaces.slice(idx + 1),
    ];
  }

  async function ensureWorkspaceByName(workspaceName: string) {
    const slug = slugifyWorkspace(workspaceName);
    if (!slug) {
      throw new Error('Nom de communaute invalide.');
    }

    const workspace = await channelService.createWorkspace({
      slug,
      name: workspaceName,
      createdBy: userId.toLowerCase(),
    });

    const sidebarWorkspace = upsertWorkspaceFromDto(workspace);
    if (sidebarWorkspace.channels.length > 0) {
      selectedChannelConversationId = sidebarWorkspace.channels[0].id;
    }
    return sidebarWorkspace;
  }

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
  let isSyncSessionOpen = $state(false);
  let syncMode = $state<'offer' | 'join'>('offer');
  let syncJoinPayload = $state('');
  let syncQrPayloadText = $state('');
  let syncQrDataUrl = $state('');
  let syncStatusText = $state('');
  let isSyncSessionBusy = $state(false);
  let showSyncGuidePrompt = $state(false);
  let hadLocalStateBeforeLogin = $state(false);

  // Group management
  let groupMembers = $state<string[]>([]);
  let sendError = $state('');

  // Reactions (messageId -> array of reactions)
  let messageReactions = new SvelteMap<string, MessageReaction[]>();

  // Reply state
  let replyingTo = $state<ChatMessage | null>(null);

  // Media
  const mediaService = new MediaService();
  const mediaMaxSizeMb = Number.parseInt(import.meta.env.VITE_MEDIA_MAX_SIZE_MB ?? '100', 10);
  const mediaMaxSizeBytes = mediaMaxSizeMb * 1024 * 1024;
  let authToken = $state('');
  let pendingMediaFiles = $state<File[]>([]);
  let isUploadingMedia = $state(false);

  let audioContext = $state<AudioContext | null>(null);
  let lastNotificationAt = $state(0);
  let lastSystemNotificationAt = $state(0);

  function playNotificationTone() {
    if (typeof window === 'undefined') return;
    const now = Date.now();
    if (now - lastNotificationAt < 600) return;
    lastNotificationAt = now;

    try {
      audioContext = audioContext ?? new AudioContext();
      const ctx = audioContext;
      const startAt = ctx.currentTime + 0.01;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(920, startAt);
      osc.frequency.exponentialRampToValueAtTime(680, startAt + 0.11);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.08, startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.14);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + 0.16);
    } catch {
      // Silent fallback for browsers restricting autoplay/audio context.
    }
  }

  async function requestSystemNotificationPermission() {
    if (typeof window === 'undefined') return;

    if (window.__TAURI_INTERNALS__) {
      try {
        const { isPermissionGranted, requestPermission } =
          await import('@tauri-apps/plugin-notification');
        const granted = await isPermissionGranted();
        if (!granted) {
          await requestPermission();
        }
      } catch {
        // Ignore if plugin is unavailable at runtime.
      }
      return;
    }

    if ('Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        // Ignore browser permission errors.
      }
    }
  }

  async function sendSystemNotification(title: string, body: string) {
    if (typeof window === 'undefined') return;

    const now = Date.now();
    if (now - lastSystemNotificationAt < 800) return;
    lastSystemNotificationAt = now;

    if (window.__TAURI_INTERNALS__) {
      try {
        const { isPermissionGranted, sendNotification } =
          await import('@tauri-apps/plugin-notification');
        if (await isPermissionGranted()) {
          await sendNotification({ title, body });
        }
        return;
      } catch {
        // Fallback to web notification below when possible.
      }
    }

    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const notification = new Notification(title, { body, tag: 'canari-message' });
        setTimeout(() => notification.close(), 5000);
      } catch {
        // Ignore browser notification construction errors.
      }
    }
  }

  // Helper to ensure MLS service exists
  function ensureMls(): IMlsService {
    if (!mls) {
      if (typeof window === 'undefined') {
        throw new Error('MLS Service unavailable outside browser context');
      }
      const w = window as Window & { __TAURI_INTERNALS__?: unknown };
      mls = w.__TAURI_INTERNALS__ ? new TauriMlsService() : new WebMlsService();
    }
    return mls;
  }

  const historyBaseUrl = (() => {
    const env = import.meta.env.VITE_HISTORY_URL;
    if (env && env.trim()) return env;
    return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001';
  })();

  function deriveConversationIdentity(
    metaName: string,
    metaId?: string
  ): {
    conversationType: 'direct' | 'group';
    contactName: string;
    displayName: string;
    directPeerId?: string;
  } {
    const normalizedName = metaName.trim();
    const oldDirectSeparator = ' & ';
    const compactDirectSeparator = '::';

    if (normalizedName.includes(compactDirectSeparator)) {
      const [a, b] = normalizedName
        .split(compactDirectSeparator)
        .map((v) => v.trim().toLowerCase());
      const peer = a === userId.toLowerCase() ? b : a;
      return {
        conversationType: 'direct',
        contactName: peer,
        displayName: peer,
        directPeerId: peer,
      };
    }

    if (normalizedName.includes(oldDirectSeparator)) {
      const participants = normalizedName
        .split(oldDirectSeparator)
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
      if (participants.length === 2 && participants.includes(userId.toLowerCase())) {
        const peer = participants.find((p) => p !== userId.toLowerCase()) || participants[0];
        return {
          conversationType: 'direct',
          contactName: peer,
          displayName: peer,
          directPeerId: peer,
        };
      }
    }

    // Legacy 1:1 conversations created with random `dm_` ids but plain peer
    // names in metadata should still be treated as direct chats.
    if (metaId?.startsWith('dm_')) {
      const peer = normalizedName.toLowerCase();
      if (peer && peer !== userId.toLowerCase()) {
        return {
          conversationType: 'direct',
          contactName: peer,
          displayName: peer,
          directPeerId: peer,
        };
      }
    }

    return {
      conversationType: 'group',
      contactName: normalizedName,
      displayName: normalizedName,
    };
  }

  function archiveStorageKey(uid: string): string {
    return `canari_archived_conversations_${uid.toLowerCase()}`;
  }

  function loadArchivedConversations(uid: string): string[] {
    try {
      const raw = localStorage.getItem(archiveStorageKey(uid));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return [...new Set(parsed.map((id) => String(id).toLowerCase()).filter(Boolean))];
    } catch {
      return [];
    }
  }

  function persistArchivedConversations(uid: string, ids: string[]) {
    localStorage.setItem(archiveStorageKey(uid), JSON.stringify([...new Set(ids)]));
  }

  function archiveConversation(conversationId: string) {
    const normalized = conversationId.toLowerCase();
    if (archivedConversationIds.includes(normalized)) return;
    archivedConversationIds = [...archivedConversationIds, normalized];
    persistArchivedConversations(userId, archivedConversationIds);

    if (selectedContact === normalized) {
      selectedContact = null;
      mobileView = 'list';
      isConversationDrawerOpen = false;
      sendError = '';
      groupMembers = [];
    }
  }

  function restoreConversation(conversationId: string) {
    const normalized = conversationId.toLowerCase();
    if (!archivedConversationIds.includes(normalized)) return;
    archivedConversationIds = archivedConversationIds.filter((id) => id !== normalized);
    persistArchivedConversations(userId, archivedConversationIds);
  }

  // Read Receipts logic
  let pendingReadReceipts: string[] = [];
  let readReceiptTimer: ReturnType<typeof setTimeout> | null = null;

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

    // Mark as read asynchronously to avoid synchronous reactivity loops (depth exceeded).
    untrack(() => {
      setTimeout(() => {
        const freshConvo = conversations.get(currentContact);
        if (!freshConvo) return;
        const newMsgs = freshConvo.messages.map((m) =>
          ids.includes(m.id) ? { ...m, readBy: [...(m.readBy || []), meNorm] } : m
        );
        conversations.set(currentContact, { ...freshConvo, messages: newMsgs });
      }, 0);
    });

    // Accumulate for batch sending to avoid flooding with MLS packets
    ids.forEach((id) => {
      if (!pendingReadReceipts.includes(id)) pendingReadReceipts.push(id);
    });

    if (!readReceiptTimer) {
      readReceiptTimer = setTimeout(() => {
        untrack(() => {
          const toSend = [...pendingReadReceipts];
          pendingReadReceipts = [];
          readReceiptTimer = null;

          if (toSend.length === 0) return;

          try {
            const mlsService = ensureMls();
            const freshConvo = conversations.get(currentContact);
            if (!freshConvo) return;

            sendReadReceipt(toSend, {
              mlsService,
              userId,
              pin,
              conversation: freshConvo,
            }).catch(() => {
              // Silently ignore — the local state is already updated.
            });
          } catch {
            // MLS not ready yet, will catch next time.
          }
        });
      }, 2000); // 2-second debounce for batching history load reads
    }
  });

  onMount(() => {
    if (routeMode === 'login') {
      // On Tauri (mobile), try biometric auto-login first
      const isTauri = !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      if (isTauri) {
        void (async () => {
          const configured = await BiometricService.isConfigured();
          if (configured) {
            biometricAvailable = true;
            await handleBiometricLogin();
          }
        })();
      } else {
        const savedUser = localStorage.getItem('canari_saved_user');
        const savedPin = localStorage.getItem('canari_saved_pin');
        if (savedUser && savedPin) {
          void goto('/chat', { replaceState: true });
        }
      }
      return;
    }

    void requestSystemNotificationPermission();

    const w = window as Window & { wasm_bindings_log?: (level: string, msg: string) => void };
    w.wasm_bindings_log = (level: string, msg: string) => {
      log(`[RUST::${level}] ${msg}`);
    };

    const w2 = window as Window & { __TAURI_INTERNALS__?: unknown };
    if (!mls) {
      if (w2.__TAURI_INTERNALS__) {
        mls = new TauriMlsService();
        log('Initialisé en mode TAURI');
      } else {
        mls = new WebMlsService();
        log('Initialisé en mode WEB (WASM)');
      }
    }

    // On Tauri (mobile), prefer biometric auto-login
    const isTauriChat = !!(window as Window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__;
    if (isTauriChat) {
      void (async () => {
        const configured = await BiometricService.isConfigured();
        if (configured) {
          biometricAvailable = true;
          await handleBiometricLogin();
          return;
        }
        // Fallback to saved credentials
        const savedUser = localStorage.getItem('canari_saved_user');
        const savedPin = localStorage.getItem('canari_saved_pin');
        if (savedUser && savedPin) {
          userId = savedUser;
          pin = savedPin;
          void handleLogin();
        } else {
          void goto('/login', { replaceState: true });
        }
      })();
    } else {
      // Web fallback
      const savedUser = localStorage.getItem('canari_saved_user');
      const savedPin = localStorage.getItem('canari_saved_pin');
      if (savedUser && savedPin) {
        userId = savedUser;
        pin = savedPin;
        void handleLogin();
      } else if (routeMode === 'chat') {
        void goto('/login', { replaceState: true });
      }
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

    hadLocalStateBeforeLogin = Boolean(localStorage.getItem('mls_autosave_' + userId));

    try {
      const mlsService = ensureMls(); // Ensure MLS is initialized

      // Verify PIN consistency across devices before doing anything else
      log('Vérification du PIN...');
      const verifier = await computePinVerifier(userId, pin);
      const verifierPayload = JSON.stringify({ userId, verifier });
      let verifierRes = await fetch(`${historyBaseUrl}/api/mls-api/pin-verifier/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: verifierPayload,
      });
      if (verifierRes.status === 404 || verifierRes.status === 405) {
        verifierRes = await fetch(`${historyBaseUrl}/mls-api/pin-verifier/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: verifierPayload,
        });
      }
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

      // Generate auth token before switching to the main view so that a missing
      // VITE_JWT_SECRET surfaces as a visible error on the login form rather than
      // being silently swallowed after isLoggedIn = true.
      authToken = await generateDevToken(
        userId,
        import.meta.env.VITE_JWT_SECRET,
        import.meta.env.DEV
      );

      isLoggedIn = true;
      archivedConversationIds = loadArchivedConversations(userId);
      showArchivedConversations = false;
      // Mémoriser les identifiants pour auto-login au prochain chargement
      localStorage.setItem('canari_saved_user', userId);
      localStorage.setItem('canari_saved_pin', pin);
      await loadExistingConversations();

      // Detect isReady conversations that have no matching MLS group state.
      // This happens when the DB was synced via QR but the device never processed
      // the MLS Welcome messages (e.g. first QR sync or after state loss). Clear
      // those devices from the known-devices cache so syncOwnDevicesToGroupsLocally()
      // will re-send Welcomes when it runs below.
      try {
        const localMlsGroups = new Set(mlsService.getLocalGroups());
        const hasMissingGroups = [...conversations.values()].some(
          (c) => c.isReady && !localMlsGroups.has(c.groupId)
        );
        if (hasMissingGroups) {
          log(
            '[WARN] Groupes sans état MLS détectés — réinitialisation du cache de synchronisation.'
          );
          localStorage.removeItem(`known_own_devices:${userId}`);
        }
      } catch {
        /* ignore — non-blocking diagnostic */
      }

      // Auto-rejoin groups where user may have lost membership after device sync
      syncOwnDevicesToGroupsLocally().catch(() => {});

      const syncGuideKey = `canari_sync_guide_seen_${userId}`;
      if (!hadLocalStateBeforeLogin && localStorage.getItem(syncGuideKey) !== '1') {
        showSyncGuidePrompt = true;
        localStorage.setItem(syncGuideKey, '1');
      }

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

      // Offer biometric enrollment on first successful login on Tauri
      const isTauri = !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      if (isTauri && !(await BiometricService.isConfigured())) {
        showBiometricEnrollPrompt = true;
      }
    } catch (_e: unknown) {
      const msg = _e instanceof Error ? _e.message : String(_e);
      loginError = msg;
      log(`Erreur: ${loginError}`);
      localStorage.removeItem('canari_saved_user');
      localStorage.removeItem('canari_saved_pin');
      if (routeMode === 'chat') {
        void goto('/login', { replaceState: true });
      }
    } finally {
      isLoggingIn = false;
    }
  }

  // --- Persistance (DB) ---

  /**
   * Retrieves the saved user + PIN from the hardware-backed Android Keystore
   * (requires OS biometric authentication) then logs in automatically.
   */
  async function handleBiometricLogin() {
    loginError = '';
    isLoggingIn = true;
    try {
      const savedUser = localStorage.getItem('canari_saved_user');
      if (!savedUser) {
        loginError = 'Aucun utilisateur enregistré pour la biométrie.';
        return;
      }
      const retrieved = await BiometricService.authenticateAndGetSecret();
      if (!retrieved) {
        loginError = "L'authentification biométrique a échoué. Entrez votre PIN manuellement.";
        return;
      }
      userId = savedUser;
      pin = retrieved;
      await handleLogin();
    } catch (e) {
      loginError = 'Échec de la biométrie. Entrez votre PIN manuellement.';
      console.error(e);
    } finally {
      isLoggingIn = false;
    }
  }

  async function enrollBiometric() {
    try {
      await BiometricService.enableBiometric(pin);
      biometricAvailable = true;
      showBiometricEnrollPrompt = false;
    } catch (e) {
      console.error('Biometric enrollment failed:', e);
    }
  }

  // --- Persistance (DB) ---

  /** Upsert conversation metadata into the persistent DB. */
  async function saveConversation(contactName: string) {
    if (!storage) return;
    const normalized = contactName.toLowerCase();
    const convo = conversations.get(normalized);
    if (!convo) return;
    const persistedName =
      (convo.conversationType ?? 'group') === 'direct'
        ? `${userId.toLowerCase()}::${(convo.directPeerId ?? convo.contactName).toLowerCase()}`
        : convo.name;

    await storage.saveConversation({
      id: normalized,
      groupId: convo.groupId,
      name: persistedName,
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
      getConversation: (name) => conversations.get(name),
      setConversation: (name, next) => {
        conversations.set(name, next);
      },
      messageReactions,
      log,
    });
  }

  async function mergeDirectConversationDuplicates(
    convMetas: ConversationMeta[]
  ): Promise<ConversationMeta[]> {
    if (!storage) return convMetas;

    const canonicalByPeer = new SvelteMap<string, ConversationMeta>();
    const duplicatesToMerge: Array<{ canonical: ConversationMeta; duplicate: ConversationMeta }> =
      [];

    for (const meta of convMetas) {
      const identity = deriveConversationIdentity(meta.name, meta.id);
      if (identity.conversationType !== 'direct' || !identity.directPeerId) {
        continue;
      }

      const peer = identity.directPeerId.toLowerCase();
      const existing = canonicalByPeer.get(peer);
      if (!existing) {
        canonicalByPeer.set(peer, meta);
        continue;
      }

      const canonical = existing.updatedAt >= meta.updatedAt ? existing : meta;
      const duplicate = canonical.id === existing.id ? meta : existing;
      canonicalByPeer.set(peer, canonical);
      duplicatesToMerge.push({ canonical, duplicate });
    }

    if (duplicatesToMerge.length === 0) {
      return convMetas;
    }

    for (const pair of duplicatesToMerge) {
      const { canonical, duplicate } = pair;
      if (canonical.id === duplicate.id) continue;

      try {
        const canonicalMessages = await storage.getMessages(canonical.id, pin);
        const duplicateMessages = await storage.getMessages(duplicate.id, pin);
        const byId = new SvelteMap<string, StoredMessage>();

        for (const message of canonicalMessages) {
          byId.set(message.id, { ...message, conversationId: canonical.id });
        }
        for (const message of duplicateMessages) {
          if (!byId.has(message.id)) {
            byId.set(message.id, { ...message, conversationId: canonical.id });
          }
        }

        const mergedMessages = Array.from(byId.values()).sort((a, b) => a.timestamp - b.timestamp);
        if (mergedMessages.length > 0) {
          await storage.saveMessages(mergedMessages, pin);
        }
        await storage.deleteConversation(duplicate.id);
        log(`Fusion de discussions 1:1 en doublon: ${duplicate.name} -> ${canonical.name}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log(`Erreur fusion discussions directes: ${msg}`);
      }
    }

    const duplicateIds = new Set(duplicatesToMerge.map((item) => item.duplicate.id));
    const merged = convMetas.filter((meta) => !duplicateIds.has(meta.id));

    // Normalize direct-conversation metadata names so future loads/syncs can
    // detect duplicates consistently, including after backup/QR sync.
    const normalizedMetas: ConversationMeta[] = [];
    for (const meta of merged) {
      const identity = deriveConversationIdentity(meta.name, meta.id);
      if (identity.conversationType !== 'direct' || !identity.directPeerId) {
        normalizedMetas.push(meta);
        continue;
      }

      const normalizedDirectName = `${userId.toLowerCase()}::${identity.directPeerId.toLowerCase()}`;
      if (meta.name === normalizedDirectName) {
        normalizedMetas.push(meta);
        continue;
      }

      try {
        const updatedMeta = { ...meta, name: normalizedDirectName, updatedAt: Date.now() };
        await storage.saveConversation(updatedMeta);
        normalizedMetas.push(updatedMeta);
      } catch {
        normalizedMetas.push(meta);
      }
    }

    return normalizedMetas;
  }

  async function loadExistingConversations() {
    if (!storage) return;

    // One-time migration from the old localStorage format
    await migrateFromLocalStorage(userId, pin, storage, log);

    const convMetas = await storage.getConversations();
    const mergedConvMetas = await mergeDirectConversationDuplicates(convMetas);

    const validConversationIds = new Set(mergedConvMetas.map((meta) => meta.id.toLowerCase()));
    const prunedArchivedIds = archivedConversationIds.filter((id) => validConversationIds.has(id));
    if (prunedArchivedIds.length !== archivedConversationIds.length) {
      archivedConversationIds = prunedArchivedIds;
      persistArchivedConversations(userId, archivedConversationIds);
    }

    conversations.clear();
    messageReactions.clear();

    // Phase 1 (fast, blocking): populate the conversations map with metadata
    // only so the WS message handler can route messages immediately.
    for (const meta of mergedConvMetas) {
      const identity = deriveConversationIdentity(meta.name, meta.id);
      conversations.set(meta.id, {
        contactName: identity.contactName,
        name: identity.displayName,
        groupId: meta.groupId,
        messages: [], // loaded asynchronously in phase 2
        isReady: meta.isReady,
        mlsStateHex: null,
        unreadCount: 0,
        conversationType: identity.conversationType,
        directPeerId: identity.directPeerId,
      });
    }

    // Phase 2 (background, non-blocking): decrypt stored messages and replay
    // remote history. Run all conversations in parallel so decryption doesn't
    // serialize across conversations.
    for (const meta of mergedConvMetas) {
      (async () => {
        try {
          const storedMessages = await storage.getMessages(meta.id, pin);
          const msgs = mapStoredMessagesToChatMessages(storedMessages, userId);
          const existing = conversations.get(meta.id);
          if (existing && msgs.length > 0) {
            conversations.set(meta.id, { ...existing, messages: msgs });
          }
          await loadHistoryForConversation(meta.id, meta.groupId);
        } catch {
          // Keep loading resilient even if one conversation fails.
        }
      })();
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

  async function createNewChannel(nameRaw: string) {
    try {
      const normalizedChannelName = nameRaw.trim().toLowerCase();
      if (!normalizedChannelName) return;

      // By default, channels are created inside the Asso community.
      const sidebarWorkspace = await ensureWorkspaceByName(DEFAULT_WORKSPACE_NAME);
      const workspaceId = sidebarWorkspace.workspaceDbId;

      if (!workspaceId) {
        throw new Error('workspaceId introuvable apres creation de la communaute.');
      }

      const channelDto = {
        workspaceId,
        name: normalizedChannelName,
        visibility: 'public' as const,
        actorUserId: userId.toLowerCase(),
      };

      const createdChannel = await channelService.createChannel(channelDto);

      // Update UI artificially for now since we don't have a sync process for channels created
      const actualId =
        createdChannel?.id || createdChannel?._id || `${workspaceId}_${normalizedChannelName}`;
      const channelId = `channel_${actualId}`;

      addChannelToWorkspace(sidebarWorkspace.id, {
        id: channelId,
        name: normalizedChannelName,
        isPrivate: false,
      });
      selectedChannelConversationId = channelId;

      if (!conversations.has(channelId)) {
        conversations.set(channelId, {
          contactName: channelId,
          name: normalizedChannelName,
          groupId: '',
          messages: [],
          isReady: true,
          mlsStateHex: null, // Zero-trust channel MLS key distribution pattern would load key here, for now it's null
        });
        await saveConversation(channelId);
        selectConversation(channelId);
      }
    } catch (e) {
      console.error('Failed to create channel:', e);
      log(`Erreur creation canal : ${String(e)}`);
    }
  }

  async function createNewCommunity(nameRaw: string) {
    try {
      const normalized = nameRaw.trim();
      if (!normalized) return;
      await ensureWorkspaceByName(normalized);
      log(`Communaute creee : ${normalized}`);
    } catch (e) {
      console.error('Failed to create community:', e);
      log(`Erreur creation communaute : ${String(e)}`);
    }
  }

  async function inviteMemberToChannel(
    channelConversationId: string,
    memberIdRaw: string,
    roleName: 'member' | 'moderator' | 'admin'
  ) {
    try {
      const memberId = memberIdRaw.trim().toLowerCase();
      const channelId = channelConversationId.replace(/^channel_/, '');
      if (!memberId || !channelId) return;

      await channelService.joinChannel(channelId, {
        userId: memberId,
        roleName,
        actorUserId: userId.toLowerCase(),
      });

      log(`Membre invite dans le canal (${roleName}) : ${memberId}`);
    } catch (e) {
      console.error('Failed to invite channel member:', e);
      log(`Erreur invitation membre canal : ${String(e)}`);
    }
  }

  async function updateChannelMemberRole(
    channelConversationId: string,
    memberIdRaw: string,
    roleName: 'member' | 'moderator' | 'admin'
  ) {
    try {
      const memberId = memberIdRaw.trim().toLowerCase();
      const channelId = channelConversationId.replace(/^channel_/, '');
      if (!memberId || !channelId) return;

      await channelService.updateMemberRole(channelId, {
        targetUserId: memberId,
        roleName,
        actorUserId: userId.toLowerCase(),
      });

      log(`Role mis a jour (${roleName}) pour : ${memberId}`);
    } catch (e) {
      console.error('Failed to update channel member role:', e);
      log(`Erreur mise a jour role canal : ${String(e)}`);
    }
  }

  async function inviteMembersToCurrentGroup(memberIds: string[]) {
    if (!selectedContact) return;
    const mlsService = ensureMls();
    const convo = conversations.get(selectedContact);
    if (!convo) return;

    const normalized = [...new Set(memberIds.map((id) => id.trim().toLowerCase()).filter(Boolean))];
    if (normalized.length === 0) return;

    await inviteMembersToGroup(normalized, convo, {
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

    await loadGroupMembers(convo.groupId);
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
    messageId?: string,
    timestamp?: Date
  ) {
    const normalized = contactName.toLowerCase();
    const convo = conversations.get(normalized);
    if (!convo) return;

    const isOwn = senderId.toLowerCase() === userId.toLowerCase();

    const newMsg: ChatMessage = {
      id: messageId || crypto.randomUUID(),
      senderId: senderId.toLowerCase(),
      content,
      timestamp: timestamp ?? new Date(),
      isOwn,
      replyTo,
      isSystem,
    };

    if (convo.messages.some((message) => message.id === newMsg.id)) {
      return;
    }

    const isConversationOpen = selectedContact === normalized;
    const shouldMarkUnread = !isOwn && !isConversationOpen;
    const nextUnreadCount = shouldMarkUnread
      ? (convo.unreadCount ?? 0) + 1
      : isConversationOpen
        ? 0
        : (convo.unreadCount ?? 0);

    conversations.set(normalized, {
      ...convo,
      unreadCount: nextUnreadCount,
      messages: [...convo.messages, newMsg],
    });

    if (shouldMarkUnread) {
      playNotificationTone();
      const preview = getPreviewText(parseEnvelope(content));
      const shouldShowSystemNotification =
        typeof document !== 'undefined' &&
        (document.visibilityState !== 'visible' || !document.hasFocus());

      if (shouldShowSystemNotification) {
        void sendSystemNotification(convo.name, preview || 'Nouveau message');
      }
    }

    // Persist message to DB (encrypted with PIN)
    // Persist the raw message envelope (skip system messages).
    if (storage && !isSystem) {
      try {
        await storage.saveMessage(
          {
            id: newMsg.id,
            conversationId: normalized,
            senderId: newMsg.senderId,
            content,
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
    const filesToSend = [...pendingMediaFiles];
    const mediaCaption = text || undefined;
    let sentMediaMessageCount = 0;

    if (!text && filesToSend.length === 0) return;
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;

    const stillMember = await verifyCurrentUserMembership(selectedContact);
    if (!stillMember || !convo.isReady) {
      sendError = 'Vous avez été retiré de ce groupe. Vous ne pouvez plus envoyer de messages.';
      return;
    }

    const currentReplyingTo = replyingTo;
    if (text) messageText = '';
    replyingTo = null;
    sendError = '';

    const mlsService = ensureMls();

    if (filesToSend.length > 0) {
      pendingMediaFiles = [];
      isUploadingMedia = true;
      try {
        if (!authToken) {
          authToken = await generateDevToken(
            userId,
            import.meta.env.VITE_JWT_SECRET,
            import.meta.env.DEV
          );
        }
        for (let index = 0; index < filesToSend.length; index++) {
          const fileToSend = filesToSend[index];
          const captionForFile = index === 0 ? mediaCaption : undefined;
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
              caption: captionForFile,
            }),
            messageId,
          });
          await mlsService.sendMessage(convo.groupId, protoBytes);
          const stateBytes = await mlsService.saveState(pin);
          localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));
          // Store as envelope locally for consistent rendering.
          const payload = serializeEnvelope(mkMediaEnvelope({ ...mediaRef }, captionForFile));
          await addMessageToChat(userId, payload, selectedContact, undefined, false, messageId);
          sentMediaMessageCount++;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (sentMediaMessageCount < filesToSend.length) {
          pendingMediaFiles = [...filesToSend.slice(sentMediaMessageCount), ...pendingMediaFiles];
        }
        if (text) {
          messageText = text;
          replyingTo = currentReplyingTo;
        }
        sendError = `Échec de l'envoi du média : ${errorMessage}`;
        log(`Erreur envoi média: ${errorMessage}`);
      } finally {
        isUploadingMedia = false;
      }
    }

    if (sentMediaMessageCount > 0) return;

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

  async function handleFilesSelected(files: File[]) {
    const readyFiles: File[] = [];

    for (const file of files) {
      if (Number.isFinite(mediaMaxSizeBytes) && file.size > mediaMaxSizeBytes) {
        const errorMessage = `Fichier trop volumineux (${(file.size / 1024 / 1024).toFixed(1)} Mo). Limite: ${mediaMaxSizeMb} Mo.`;
        sendError = errorMessage;
        log(`Erreur envoi média: ${errorMessage}`);
        continue;
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

      readyFiles.push(processedFile);
    }

    if (readyFiles.length > 0) {
      pendingMediaFiles = [...pendingMediaFiles, ...readyFiles];
    }
  }

  function removePendingMediaFile(index: number) {
    pendingMediaFiles = pendingMediaFiles.filter((_, i) => i !== index);
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
      newMsgs[idx] = {
        ...newMsgs[idx],
        isEdited: true,
        editedAt: new Date(),
        content: text,
        readBy: [],
      };
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
    isConversationDrawerOpen = false;
    sendError = '';

    const convo = conversations.get(name);
    if (convo) {
      conversations.set(name, { ...convo, unreadCount: 0 });
    }

    // Load member list for the selected group
    if (convo?.groupId) {
      loadGroupMembers(convo.groupId);
      void verifyCurrentUserMembership(name);
    }
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

  async function verifyCurrentUserMembership(contactName: string): Promise<boolean> {
    const convo = conversations.get(contactName);
    if (!convo) return false;

    try {
      const mlsService = ensureMls();
      const members = await fetchUniqueGroupMembers(mlsService, convo.groupId);
      const stillMember = members.includes(userId.toLowerCase());

      if (stillMember) return true;

      if (convo.isReady) {
        conversations.set(contactName, { ...convo, isReady: false });
      }

      const notice =
        'Vous avez ete retire de ce groupe. Vous ne pouvez plus envoyer ni recevoir de nouveaux messages.';
      const hasNotice = convo.messages.some((m) => m.isSystem && m.content === notice);
      if (!hasNotice) {
        await addSystemMessage(notice, contactName);
      }

      if (selectedContact === contactName) {
        sendError = notice;
      }

      return false;
    } catch {
      return true;
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
      await addSystemMessage(`${userId} a renommé le groupe en "${name}"`, selectedContact);
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
    archiveConversation(selectedContact);
    log(`Discussion "${convo.name}" déplacée dans la corbeille.`);
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
      await addSystemMessage(`${userId} a retiré ${memberId} du groupe`, selectedContact);
      await loadGroupMembers(convo.groupId);
      log(`${memberId} retiré du groupe.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Erreur retrait membre: ${msg}`);
    }
  }

  function goBackToMenu() {
    mobileView = 'list';
    isConversationDrawerOpen = false;
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
      log('[OK] Reconnecte au reseau.');
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
    pendingMediaFiles = [];
    isUploadingMedia = false;
    groupMembers = [];
    sendError = '';
    showBiometricEnrollPrompt = false;
    localStorage.removeItem('canari_saved_user');
    localStorage.removeItem('canari_saved_pin');

    if (routeMode === 'chat') {
      void goto('/login', { replaceState: true });
    }
  }

  async function purgeLocalCaches() {
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
  }

  async function resetAll() {
    await purgeLocalCaches();
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

  async function runSyncRound(sessionId: string, peerDeviceId: string) {
    if (!storage) throw new Error('Stockage local indisponible');
    const result = await executeBidirectionalSyncRound({
      historyBaseUrl,
      storage,
      pin,
      userId,
      myDeviceId,
      peerDeviceId,
      sessionId,
    });

    await loadExistingConversations();

    // After DB sync, force MLS re-invite for the peer: remove it from the
    // known-devices cache so syncOwnDevicesToGroupsLocally() will send Welcome
    // messages even if this device pair was already processed before.
    try {
      const cacheKey = `known_own_devices:${userId}`;
      const known: string[] = JSON.parse(localStorage.getItem(cacheKey) ?? '[]');
      localStorage.setItem(cacheKey, JSON.stringify(known.filter((id) => id !== peerDeviceId)));
    } catch {
      /* ignore */
    }

    // Re-send MLS Welcomes so the peer can decrypt messages in existing groups.
    await syncOwnDevicesToGroupsLocally();

    log(
      `[SYNC] Terminee. Envoyes: ${result.uploadedMessageCount}, importes: ${result.importedMessageCount}.`
    );
  }

  async function handleStartSyncSession() {
    try {
      isSyncSessionBusy = true;
      isSyncSessionOpen = true;
      syncMode = 'offer';
      syncStatusText = 'Initialisation de la session QR...';

      const offerPublicKey = generateEphemeralPublicKey();
      const session = await startSyncSession(historyBaseUrl, {
        userId,
        deviceId: myDeviceId,
        offerPublicKey,
      });

      syncQrPayloadText = encodeSyncQrPayload(session.qrPayload);
      syncQrDataUrl = await createSyncQrDataUrl(syncQrPayloadText);
      syncStatusText = 'Session creee. En attente de jonction du second appareil...';

      const waitUntil = Date.now() + 180_000;
      while (Date.now() < waitUntil) {
        const state = await getSyncSessionState(historyBaseUrl, {
          sessionId: session.sessionId,
          userId,
        });
        if (state.state === 'joined' && state.answerDeviceId) {
          syncStatusText = 'Appareil rejoint. Synchronisation bidirectionnelle en cours...';
          await runSyncRound(session.sessionId, state.answerDeviceId);
          syncStatusText = 'Synchronisation terminee.';
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }

      throw new Error("Timeout: aucun appareil n'a rejoint la session");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      syncStatusText = `Erreur sync: ${msg}`;
      log(`[SYNC] Erreur source: ${msg}`);
    } finally {
      isSyncSessionBusy = false;
    }
  }

  function openJoinSyncModal() {
    syncMode = 'join';
    syncJoinPayload = '';
    syncQrPayloadText = '';
    syncQrDataUrl = '';
    syncStatusText = '';
    isSyncSessionOpen = true;
  }

  async function handleConfirmJoinSync() {
    try {
      isSyncSessionBusy = true;
      syncStatusText = 'Lecture du payload QR...';
      const payload = parseSyncQrPayload(syncJoinPayload.trim());

      if (payload.userId !== userId) {
        throw new Error('Le payload appartient a un autre utilisateur');
      }

      const answerPublicKey = generateEphemeralPublicKey();
      const joinRes = await joinSyncSession(historyBaseUrl, {
        sessionId: payload.sessionId,
        joinToken: payload.joinToken,
        userId,
        deviceId: myDeviceId,
        answerPublicKey,
      });

      syncStatusText = 'Session rejointe. Synchronisation bidirectionnelle en cours...';
      await runSyncRound(payload.sessionId, joinRes.offerDeviceId);
      syncStatusText = 'Synchronisation terminee.';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      syncStatusText = `Erreur sync: ${msg}`;
      log(`[SYNC] Erreur cible: ${msg}`);
    } finally {
      isSyncSessionBusy = false;
    }
  }

  async function copySyncPayload() {
    if (!syncQrPayloadText) return;

    const payload = syncQrPayloadText;

    try {
      await navigator.clipboard.writeText(payload);
      syncStatusText = 'Payload copie dans le presse-papiers.';
      return;
    } catch {
      // Fallback to legacy copy for mobile/webviews without Clipboard API support.
    }

    try {
      const textarea = document.createElement('textarea');
      textarea.value = payload;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (copied) {
        syncStatusText = 'Payload copie dans le presse-papiers.';
        return;
      }
    } catch {
      // Ignore and fallback to share.
    }

    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Canari Sync QR Payload',
          text: payload,
        });
        syncStatusText = 'Payload partage avec succes.';
        return;
      } catch {
        // User may cancel share; continue to final message.
      }
    }

    syncStatusText =
      'Impossible de copier automatiquement. Utilisez le partage ou copiez le texte manuellement.';
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

  function openQrGuideSync() {
    showSyncGuidePrompt = false;
    openJoinSyncModal();
    syncStatusText =
      'Sur votre appareil principal: Menu + > Synchronisation > Afficher le QR, puis scannez-le ici.';
  }
</script>

<!-- ==================== UI ==================== -->

{#if !isLoggedIn}
  {#if routeMode === 'login'}
    <LoginForm
      {userId}
      {pin}
      {isLoggingIn}
      {loginError}
      {biometricAvailable}
      onUserIdChange={(value) => (userId = value)}
      onPinChange={(value) => (pin = value)}
      onLogin={handleLogin}
      onBiometricLogin={handleBiometricLogin}
      onReset={resetAll}
    />
  {:else}
    <div class="min-h-screen flex items-center justify-center text-sm text-text-muted">
      Redirection vers la page de connexion...
    </div>
  {/if}
{:else}
  <div class="app-layout" in:fade>
    <Navbar {isWsConnected} onToggleLogs={() => (showLogs = !showLogs)} onLogout={logout} />

    {#if showBiometricEnrollPrompt}
      <div
        class="fixed bottom-[env(safe-area-inset-bottom,0px)] left-0 right-0 z-50 mx-4 mb-4 p-4 rounded-2xl border border-cn-border shadow-lg flex items-center gap-3"
        style="background: color-mix(in srgb, var(--cn-surface) 95%, transparent); backdrop-filter: blur(10px);"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="shrink-0 text-cn-yellow"
        >
          <path d="M12 10a2 2 0 0 0-2 2c0 1.02.5 1.93 1.27 2.49" />
          <path d="M12 2a10 10 0 0 1 9.39 6.52" />
          <path d="M12 22C6.48 22 2 17.52 2 12" />
          <path d="M4.93 4.93a10 10 0 0 0-.93 3" />
          <path d="M19.07 4.93A10 10 0 0 1 22 12" />
          <path d="M15.36 17.12A5 5 0 0 1 7 14" />
          <path d="M12 7a5 5 0 0 1 4.9 4" />
        </svg>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold text-text-main">
            Activer le déverrouillage par empreinte ?
          </p>
          <p class="text-xs text-text-muted">
            Votre PIN sera stocké de façon sécurisée et récupérable uniquement par biométrie.
          </p>
        </div>
        <div class="flex gap-2 shrink-0">
          <button
            onclick={() => (showBiometricEnrollPrompt = false)}
            class="px-3 py-1.5 text-xs text-text-muted rounded-xl border border-cn-border hover:border-cn-yellow transition-colors"
          >
            Plus tard
          </button>
          <button
            onclick={enrollBiometric}
            class="px-3 py-1.5 text-xs font-bold text-cn-dark bg-cn-yellow rounded-xl hover:bg-cn-yellow-hover transition-colors"
          >
            Activer
          </button>
        </div>
      </div>
    {/if}

    <!-- CONTENT -->
    <main class="main-content">
      <Sidebar
        {conversations}
        {archivedConversationIds}
        {showArchivedConversations}
        {selectedContact}
        {newContactInput}
        {newGroupInput}
        {newChannelInput}
        onContactInputChange={(value) => (newContactInput = value)}
        onGroupInputChange={(value) => (newGroupInput = value)}
        onChannelInputChange={(value) => (newChannelInput = value)}
        onAddContact={(value?: string) => {
          const contact = (value ?? newContactInput).trim();
          if (contact) {
            startNewConversation(contact);
            newContactInput = '';
          }
        }}
        onCreateGroup={(value?: string) => {
          const group = (value ?? newGroupInput).trim();
          if (group) {
            createNewGroup(group);
            newGroupInput = '';
          }
        }}
        onCreateChannel={(value?: string) => {
          const channel = (value ?? newChannelInput).trim();
          if (channel) {
            createNewChannel(channel);
            newChannelInput = '';
          }
        }}
        onCreateWorkspace={(value?: string) => {
          const workspaceName = (value ?? '').trim();
          if (workspaceName) {
            createNewCommunity(workspaceName);
          }
        }}
        onInviteChannelMember={(channelId, memberId, roleName) => {
          inviteMemberToChannel(channelId, memberId, roleName);
        }}
        onUpdateChannelMemberRole={(channelId, memberId, roleName) => {
          updateChannelMemberRole(channelId, memberId, roleName);
        }}
        onSelectConversation={selectConversation}
        onSelectChannelConversation={(channelId) => {
          selectedChannelConversationId = channelId;
          selectConversation(channelId);
        }}
        {channelWorkspaces}
        selectedChannelId={selectedChannelConversationId}
        onToggleArchivedView={() => {
          showArchivedConversations = !showArchivedConversations;
        }}
        onRestoreConversation={restoreConversation}
        onExport={handleExport}
        onImport={handleImport}
        onStartSync={handleStartSyncSession}
        onJoinSync={openJoinSyncModal}
        {isExporting}
        {isImporting}
        isSyncing={isSyncSessionBusy}
        isHidden={mobileView === 'chat'}
      />

      <ChatArea
        conversation={currentConvo}
        {messageText}
        onMessageChange={(value) => (messageText = value)}
        onSend={handleSendChat}
        onInviteMembers={inviteMembersToCurrentGroup}
        onBack={goBackToMenu}
        onOpenConversations={() => {
          isConversationDrawerOpen = true;
        }}
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
        onFilesSelected={handleFilesSelected}
        pendingFiles={pendingMediaFiles}
        onRemovePendingFile={removePendingMediaFile}
        isUploading={isUploadingMedia}
      />

      <ChannelPermissionsPanel
        selectedChannelId={selectedChannelConversationId}
        {channelWorkspaces}
        onInviteMember={(channelId, memberId, roleName) => {
          inviteMemberToChannel(channelId, memberId, roleName);
        }}
        onUpdateMemberRole={(channelId, memberId, roleName) => {
          updateChannelMemberRole(channelId, memberId, roleName);
        }}
      />

      {#if isConversationDrawerOpen}
        <Sidebar
          {conversations}
          {archivedConversationIds}
          {showArchivedConversations}
          {selectedContact}
          {newContactInput}
          {newGroupInput}
          {newChannelInput}
          onContactInputChange={(value) => (newContactInput = value)}
          onGroupInputChange={(value) => (newGroupInput = value)}
          onChannelInputChange={(value) => (newChannelInput = value)}
          onAddContact={(value?: string) => {
            const contact = (value ?? newContactInput).trim();
            if (contact) {
              startNewConversation(contact);
              newContactInput = '';
            }
          }}
          onCreateGroup={(value?: string) => {
            const group = (value ?? newGroupInput).trim();
            if (group) {
              createNewGroup(group);
              newGroupInput = '';
            }
          }}
          onCreateChannel={(value?: string) => {
            const channel = (value ?? newChannelInput).trim();
            if (channel) {
              createNewChannel(channel);
              newChannelInput = '';
            }
          }}
          onCreateWorkspace={(value?: string) => {
            const workspaceName = (value ?? '').trim();
            if (workspaceName) {
              createNewCommunity(workspaceName);
            }
          }}
          onInviteChannelMember={(channelId, memberId, roleName) => {
            inviteMemberToChannel(channelId, memberId, roleName);
          }}
          onUpdateChannelMemberRole={(channelId, memberId, roleName) => {
            updateChannelMemberRole(channelId, memberId, roleName);
          }}
          onSelectConversation={selectConversation}
          onSelectChannelConversation={(channelId) => {
            selectedChannelConversationId = channelId;
            selectConversation(channelId);
          }}
          {channelWorkspaces}
          selectedChannelId={selectedChannelConversationId}
          onToggleArchivedView={() => {
            showArchivedConversations = !showArchivedConversations;
          }}
          onRestoreConversation={restoreConversation}
          onExport={handleExport}
          onImport={handleImport}
          onStartSync={handleStartSyncSession}
          onJoinSync={openJoinSyncModal}
          {isExporting}
          {isImporting}
          isSyncing={isSyncSessionBusy}
          isHidden={false}
          drawerMode={true}
          onCloseDrawer={() => {
            isConversationDrawerOpen = false;
          }}
        />
      {/if}

      <SyncSessionModal
        isOpen={isSyncSessionOpen}
        mode={syncMode}
        qrPayload={syncQrPayloadText}
        qrDataUrl={syncQrDataUrl}
        joinPayload={syncJoinPayload}
        statusText={syncStatusText}
        isBusy={isSyncSessionBusy}
        onJoinPayloadChange={(value: string) => (syncJoinPayload = value)}
        onConfirmJoin={handleConfirmJoinSync}
        onCopyPayload={copySyncPayload}
        onClose={() => {
          if (!isSyncSessionBusy) {
            isSyncSessionOpen = false;
          }
        }}
      />

      <Modal
        open={showSyncGuidePrompt}
        onClose={() => (showSyncGuidePrompt = false)}
        title="Nouveau appareil détecté"
      >
        <div class="space-y-3 text-sm text-text-main">
          <p>
            Pour recuperer vos conversations, lancez une synchronisation QR avec un appareil deja
            connecte.
          </p>
          <ol class="list-decimal list-inside space-y-1 text-text-muted">
            <li>Sur l'appareil principal: ouvrez la synchronisation QR.</li>
            <li>Affichez le QR de transfert.</li>
            <li>Sur ce nouvel appareil: scannez le QR ou collez le payload.</li>
          </ol>
          <button
            onclick={openQrGuideSync}
            class="w-full mt-2 px-3 py-2 rounded-xl bg-cn-dark text-white font-medium hover:bg-gray-800 transition-colors"
          >
            Ouvrir la synchronisation QR
          </button>
        </div>
      </Modal>

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
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
    width: 100%;
  }

  .main-content {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    position: relative;
    z-index: 1;
    backdrop-filter: saturate(1.02);
  }
</style>
