<script lang="ts">
  import { TauriMlsService, WebMlsService } from "$lib/mlsService";
  import type { IMlsService } from "$lib/mlsService";
  import { onMount, tick } from "svelte";
  import { format } from "date-fns";

  // --- Types ---
  interface ChatMessage {
    id: string;
    senderId: string;
    content: string;
    timestamp: Date;
    isOwn: boolean;
  }

  interface Conversation {
    contactName: string; // Used for display or member list
    name: string; // Group Name
    groupId: string;
    messages: ChatMessage[];
    isReady: boolean;
    mlsStateHex: string | null;
  }

  // --- State (Runes) ---
  let userId = $state("alice");
  let pin = $state("1234");
  let isLoggedIn = $state(false);
  let isLoggingIn = $state(false);
  let loginError = $state("");
  let statusLog = $state<string[]>([]);
  let showLogs = $state(false);

  let conversations = $state<Map<string, Conversation>>(new Map());
  let selectedContact = $state<string | null>(null);
  let newContactInput = $state("");
  let newGroupInput = $state("");
  let inviteMemberInput = $state("");
  let isAddingContact = $state(false);
  let messageText = $state("");
  let chatContainer = $state<HTMLElement>();

  let isWsConnected = $state(false);

  // Service health status
  interface ServiceStatus {
    name: string;
    ok: boolean | null;
  }

  // Derived values for reactive rendering
  let currentConvo = $derived(
    selectedContact ? (conversations.get(selectedContact) ?? null) : null,
  );
  let currentMessages = $derived(currentConvo?.messages ?? []);

  // Debug state (hidden by default)
  let lastKeyPackage = $state("");
  let incomingBytesHex = $state("");
  let lastCommit = $state("");
  let lastWelcome = $state("");

  // Service
  let mls: IMlsService;

  onMount(() => {
    (window as any).wasm_bindings_log = (level: string, msg: string) => {
      log(`[RUST::${level}] ${msg}`);
    };

    if (window.__TAURI_INTERNALS__) {
      mls = new TauriMlsService();
      log("Initialized in TAURI mode");
    } else {
      mls = new WebMlsService();
      log("Initialized in WEB (WASM) mode");
    }
  });

  function log(msg: string) {
    statusLog = [...statusLog, `[${new Date().toLocaleTimeString()}] ${msg}`];
    // Auto-scroll logs
    tick().then(() => {
      const logEl = document.getElementById("logContainer");
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    });
  }

  // --- Token generation ---
  async function generateDevToken(uid: string) {
    const secret =
      "9a2f8c4e6b0d71f3e8b925b1234567890abcdef1234567890abcdef12345678";
    const header = JSON.stringify({ alg: "HS256", typ: "JWT" });
    const payload = JSON.stringify({
      sub: uid,
      exp: Math.floor(Date.now() / 1000) + 3600 * 24,
    });
    const b64url = (str: string) =>
      btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const unsignedToken = `${b64url(header)}.${b64url(payload)}`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      enc.encode(unsignedToken),
    );
    const sigB64 = b64url(String.fromCharCode(...new Uint8Array(signature)));
    return `${unsignedToken}.${sigB64}`;
  }

  // --- Auth ---
  async function handleLogin() {
    loginError = "";
    isLoggingIn = true;

    // Normalize userId to lowercase to avoid alice/Alice duplicates
    userId = userId.trim().toLowerCase();

    try {
      if (!mls)
        throw new Error("MLS Service non initialisé. Rechargez la page.");

      log("Initialisation MLS...");
      let stateBytes: Uint8Array | undefined;
      const saved = localStorage.getItem("mls_autosave_" + userId);
      if (saved) {
        const bytes = new Uint8Array(saved.length / 2);
        for (let i = 0; i < saved.length; i += 2) {
          bytes[i / 2] = parseInt(saved.substring(i, i + 2), 16);
        }
        stateBytes = bytes;
        log("État chiffré chargé depuis le stockage local.");
      }

      await mls.init(userId, pin, stateBytes);
      log(`Identité MLS initialisée pour ${userId}`);

      isLoggedIn = true;
      loadExistingConversations();
      log("Conversations chargées !");

      // listener setup before connection to catch pending messages
      mls.onMessage(async (sender, content, groupId) => {
        log(`Message reçu de ${sender} (${content.length} octets) groupe=${groupId}`);
        const senderNorm = sender.toLowerCase();

        // ── Step 1: find the conversation by groupId (reliable) or by sender (1-to-1 fallback) ──
        let convoKey: string | undefined;
        if (groupId) {
          for (const [k, c] of conversations.entries()) {
            if (c.groupId === groupId) { convoKey = k; break; }
          }
        }
        if (!convoKey && conversations.has(senderNorm)) {
          convoKey = senderNorm;
        }

        // ── Step 2a: known conversation → process as MLS message, never fall through to welcome ──
        if (convoKey) {
          const convo = conversations.get(convoKey)!;
          try {
            const decrypted = await mls.processIncomingMessage(convo.groupId, content);

            try {
              const stateBytes = await mls.saveState(pin);
              localStorage.setItem("mls_autosave_" + userId, toHex(stateBytes));
            } catch (saveErr) {
              log(`Avertissement: sauvegarde état échouée: ${saveErr}`);
            }

            if (decrypted) {
              addMessageToChat(senderNorm, decrypted, false, convoKey);
            } else {
              log(`Message de protocole (commit/proposal) traité pour "${convoKey}".`);
            }
            return true;
          } catch (e) {
            // processIncomingMessage threw — log and stop. Do NOT try processWelcome on known-group bytes.
            log(`Erreur traitement message dans groupe connu "${convoKey}": ${e}`);
            return false;
          }
        }

        // ── Step 2b: unknown conversation → must be a Welcome message ──
        try {
          const joinedGroupId = await mls.processWelcome(content);
          const extractedContact = senderNorm;

          // groupId from the message metadata (sent explicitly by the inviter) is the
          // canonical key in the delivery service DB. Prefer it over what processWelcome
          // returns (same UUID, but avoid any encoding mismatch).
          const lookupGroupId = groupId || joinedGroupId;

          // Fetch the real group name from the server
          let groupName = extractedContact;
          try {
            const gRes = await fetch(`${import.meta.env.VITE_HISTORY_URL ?? 'http://localhost:3001'}/mls-api/groups/${lookupGroupId}`);
            if (gRes.ok) {
              const gData = await gRes.json();
              if (gData?.name) groupName = gData.name;
              else log(`⚠️ Groupe ${lookupGroupId} trouvé mais sans nom`);
            } else {
              log(`⚠️ Groupe ${lookupGroupId} introuvable sur le serveur (${gRes.status})`);
            }
          } catch (e) {
            log(`⚠️ Impossible de récupérer le nom du groupe: ${e}`);
          }

          if (!conversations.has(extractedContact)) {
            log(`✨ Nouvelle conversation avec ${extractedContact} (groupe: ${groupName})`);
            conversations.set(extractedContact, {
              contactName: extractedContact,
              name: groupName,
              groupId: joinedGroupId,
              messages: [],
              isReady: true,
              mlsStateHex: null,
            });
          }

          const c = conversations.get(extractedContact)!;
          conversations.set(extractedContact, { ...c, isReady: true, groupId: joinedGroupId, name: groupName });
          saveConversation(extractedContact);

          try {
            const stateBytes = await mls.saveState(pin);
            localStorage.setItem("mls_autosave_" + userId, toHex(stateBytes));
          } catch (_) {}

          log(`✅ Handshake complété avec ${extractedContact} (groupe: ${groupName})`);
          loadHistoryForConversation(extractedContact, joinedGroupId);
          conversations = new Map(conversations);
          return true;
        } catch (e2) {
          log(`Message ignoré de ${sender} (groupe inconnu, pas un welcome valide: ${e2})`);
          return false;
        }
      });

      log("Connexion au Chat Gateway...");
      try {
        const token = await generateDevToken(userId);
        await mls.connect(token);
        isWsConnected = true;
        log("Connecté au Gateway Chat !");
      } catch (wsErr: any) {
        log(`Attention: Gateway inaccessible (${wsErr.message || wsErr}).`);
      }

      // Auto-publish KeyPackage on login
      try {
        await mls.generateKeyPackage(pin);
        log("KeyPackage public publié (prêt pour recevoir des invitations).");
      } catch (e) {
        log(`Erreur publication KeyPackage: ${e}`);
      }
    } catch (e: any) {
      console.error(e);
      const msg = e.message || String(e);
      log(`Erreur login: ${msg}`);
      loginError = msg;
    } finally {
      isLoggingIn = false;
    }
  }

  // --- Utils ---
  function generateGroupId(user1: string, user2: string): string {
    return [user1.toLowerCase(), user2.toLowerCase()].sort().join("-");
  }

  function toHex(buffer: Uint8Array): string {
    return Array.from(buffer)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  function fromHex(hex: string): Uint8Array {
    const clean = hex.replace(/\s+/g, "").replace(/[^0-9a-fA-F]/g, "");
    const match = clean.match(/.{1,2}/g);
    if (!match) return new Uint8Array();
    return new Uint8Array(match.map((byte) => parseInt(byte, 16)));
  }

  // --- Persistence ---
  function saveConversation(contactName: string) {
    const normalized = contactName.toLowerCase();
    const convo = conversations.get(normalized);
    if (!convo) return;
    const key = `conversation:${userId}:${normalized}`;
    localStorage.setItem(
      key,
      JSON.stringify({
        groupId: convo.groupId, // Store group ID
        name: convo.name,       // Store group Name
        messages: convo.messages.map((m) => ({
          ...m,
          timestamp: m.timestamp.toISOString(),
        })),
        isReady: convo.isReady,
      }),
    );
  }

  async function loadHistoryForConversation(
    contactName: string,
    groupId: string,
  ) {
    const normalized = contactName.toLowerCase();
    try {
      const history = await mls.fetchHistory(groupId);
      if (history.length > 0) {
        log(`Synchronisation historique serveur (${history.length} msg)...`);

        let addedMsg = 0;
        let mlsUpdated = false;

        for (const msg of history) {
          if (msg.sender_id === userId) continue;

          try {
            const bytesStr = atob(msg.content);
            const bytes = new Uint8Array(bytesStr.length);
            for (let i = 0; i < bytesStr.length; i++)
              bytes[i] = bytesStr.charCodeAt(i);

            const decrypted = await mls.processIncomingMessage(groupId, bytes);
            if (decrypted) {
              addMessageToChat(msg.sender_id, decrypted, false, contactName);
              addedMsg++;
              mlsUpdated = true;
            }
          } catch (err) {
            // Silently ignore errors - usually means message was already decrypted in a previous session
            // or is from an outdated epoch. OpenMLS prevents reusing secrets anyway.
          }
        }

        if (mlsUpdated) {
          try {
            const stateBytes = await mls.saveState(pin);
            const hex = toHex(stateBytes);
            localStorage.setItem("mls_autosave_" + userId, hex);
          } catch (e) {}
          if (addedMsg > 0) {
            log(
              `✅ ${addedMsg} message(s) manquant(s) récupéré(s) depuis l'historique.`,
            );
          }
        }
      }
    } catch (e: any) {
      log(`Erreur chargement historique: ${e}`);
    }
  }

  function loadExistingConversations() {
    const prefix = `conversation:${userId}:`;
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix)) {
            const contactName = key.substring(prefix.length).toLowerCase();
            const saved = localStorage.getItem(key);
            if (saved) {
                const convoData = JSON.parse(saved);
                // Use stored groupId if available, else derive (legacy support)
                const groupId = convoData.groupId || generateGroupId(userId, contactName);
                const name = convoData.name || contactName; // Default name

                const messages: ChatMessage[] = (convoData.messages || []).map(
                    (m: any) => ({
                    ...m,
                    timestamp: new Date(m.timestamp),
                    }),
                );
                
                conversations.set(contactName, {
                    contactName,
                    name,
                    groupId,
                    messages,
                    isReady: convoData.isReady || false,
                    mlsStateHex: null,
                });
                
                log(`Conversation chargée avec ${contactName} (${groupId})`);
                loadHistoryForConversation(contactName, groupId);
            }
        }
    }
  }

  // --- Conversations ---
  async function createNewGroup(nameRaw: string) {
    if (!nameRaw.trim()) return;
    const name = nameRaw.trim();

    if (conversations.has(name)) {
        log(`Un groupe ou contact nommé "${name}" existe déjà.`);
        return;
    }

    log(`Création du groupe distant "${name}"...`);
    let groupId: string;
    try {
        groupId = await mls.createRemoteGroup(name);
        log(`Groupe ID: ${groupId}`);
    } catch (e) {
        log(`Erreur création groupe distant: ${e}`);
        return;
    }

    try {
        await mls.createGroup(groupId);
        await mls.registerMember(groupId, userId, mls.getDeviceId());
        
        const stateBytes = await mls.saveState(pin);
        const hex = toHex(stateBytes);
        localStorage.setItem("mls_autosave_" + userId, hex);

        conversations.set(name, {
            contactName: name, 
            name: name,
            groupId,
            messages: [],
            isReady: true, 
            mlsStateHex: null,
        });
        conversations = new Map(conversations);
        selectedContact = name;
        saveConversation(name);
        
        log(`Groupe "${name}" prêt!`);
    } catch (e) {
        log(`Erreur init groupe local: ${e}`);
    }
  }

  async function inviteMemberToCurrentGroup(memberId: string) {
      if (!selectedContact || !memberId.trim()) return;
      const targetUser = memberId.trim().toLowerCase();
      
      const convo = conversations.get(selectedContact);
      if (!convo) return;
      const groupId = convo.groupId;

      log(`Invitation de ${targetUser}...`);
      try {
          const target = await mls.fetchKeyPackage(targetUser);
          if (!target) {
              log(`Impossible de trouver ${targetUser}.`);
              return;
          }

          // Ensure the inviter (ourselves) is also registered so messages route back to us.
          await mls.registerMember(groupId, userId, mls.getDeviceId());

          const result = await mls.addMember(groupId, target.keyPackage);
          await mls.registerMember(groupId, targetUser, target.deviceId);

          const stateBytes = await mls.saveState(pin);
          const hex = toHex(stateBytes);
          localStorage.setItem("mls_autosave_" + userId, hex);
          
          if (result.welcome) {
              await mls.sendWelcome(result.welcome!, targetUser, groupId, target.deviceId);
              log(`Welcome envoyé à ${targetUser} (device: ${target.deviceId}).`);
          }

          log(`${targetUser} ajouté avec succès.`);
      } catch(e) {
          log(`Erreur invitation: ${e}`);
      }
  }

  async function startNewConversation(contactNameRaw: string) {
    const contact = contactNameRaw.trim().toLowerCase();
    if (!contact || contact === userId) {
      log("⚠️ Nom de contact invalide ou c'est le vôtre !");
      return;
    }
    if (conversations.has(contact)) {
      selectedContact = contact;
      return;
    }

    log(`Démarrage d'une conversation avec ${contact}...`);
    // Create remote group via backend
    const groupName = `${userId} & ${contact}`;
    let groupId: string;
    try {
        log(`Demande de création de groupe au serveur (nom: ${groupName})...`);
        groupId = await mls.createRemoteGroup(groupName);
        log(`Groupe créé: ${groupId}`);
    } catch (e) {
        log(`Erreur création groupe distant: ${e}`);
        return;
    }

    conversations.set(contact, {
      contactName: contact,
      name: groupName,
      groupId,
      messages: [],
      isReady: false,
      mlsStateHex: null,
    });
    conversations = new Map(conversations);
    selectedContact = contact;

    try {
      log(`Initialisation locale du groupe ${groupId}...`);
      await mls.createGroup(groupId);

      // Register self as a member so the gateway can route messages from the other party back to us.
      await mls.registerMember(groupId, userId, mls.getDeviceId());
      
      // Persist state after group creation
      try {
        const stateBytes = await mls.saveState(pin);
        const hex = toHex(stateBytes);
        localStorage.setItem("mls_autosave_" + userId, hex);
      } catch (e) {
        log(`Erreur sauvegarde état: ${e}`);
      }

      // Try to fetch existing KeyPackage first (asynchronous mode)
      log(`Recherche du KeyPackage pour ${contact}...`);
      const target = await mls.fetchKeyPackage(contact);

      // Try to fetch existing KeyPackages for ALL devices
      log(`Recherche des appareils pour ${contact}...`);
      const devices = await mls.fetchUserDevices(contact);

      if (devices.length > 0) {
        log(`${devices.length} appareil(s) trouvé(s) pour ${contact}. Ajout au groupe...`);
        
        for (const device of devices) {
            try {
                log(`Ajout de l'appareil ${device.deviceId}...`);
                const result = await mls.addMember(groupId, device.keyPackage);
                
                // Register members to backend so gateway can route future messages
                await mls.registerMember(groupId, contact, device.deviceId);

                // Save state immediately after adding member 
                const stateBytes = await mls.saveState(pin);
                const hex = toHex(stateBytes);
                localStorage.setItem("mls_autosave_" + userId, hex);
                
                if (result.welcome) {
                    const wRes = await fetch(`${import.meta.env.VITE_HISTORY_URL ?? 'http://localhost:3001'}/mls-api/welcome`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            targetDeviceId: device.deviceId,
                            targetUserId: contact,
                            senderUserId: userId,
                            welcomePayload: btoa(String.fromCharCode(...result.welcome!)),
                            groupId: groupId
                        })
                    });
                    if (!wRes.ok) {
                        log(`⚠️ Erreur envoi welcome (${wRes.status}): ${await wRes.text()}`);
                    } else {
                        log(`Welcome envoyé à ${contact} (device: ${device.deviceId})`);
                    }
                }
                
                // Broadcast COMMIT to existing members (if any other than me)
                // In a new group, it's just me and the new member(s). 
                // But for group consistency, we must broadcast the commit if there were other members.
                // The gateway will route it.
                if (result.commit) {
                     // Prefer WebSocket for COMMIT messages to be instant
                     log(`Diffusion du Commit via WebSocket pour ${device.deviceId}`);
                     await mls.sendCommit(result.commit, groupId);
                }

            } catch(e) {
                log(`Erreur lors de l'ajout du device ${device.deviceId}: ${e}`);
            }
        }

        const convo = conversations.get(contact);
        if (convo) {
          const updatedConvo = { ...convo, isReady: true };
          conversations.set(contact, updatedConvo);
          conversations = new Map(conversations);
          saveConversation(contact);
          log(`✅ Chiffrement E2E actif avec ${contact} (tous les appareils)`);
          loadHistoryForConversation(contact, groupId);
        }
      } else {
        log(`❌ Impossible de trouver des KeyPackages pour ${contact}.`);
        conversations.delete(contact);
        conversations = new Map(conversations);
      }
    } catch (e: any) {
      log(`Erreur: ${e.message}`);
      conversations.delete(contact);
      conversations = new Map(conversations);
    }
  }

  // --- Messages ---
  function addMessageToChat(
    senderId: string,
    content: string,
    isOwn: boolean,
    contactName: string,
  ) {
    const normalized = contactName.toLowerCase();
    const convo = conversations.get(normalized);
    if (!convo) return;

    const newMsg: ChatMessage = {
      id: crypto.randomUUID(),
      senderId: senderId.toLowerCase(),
      content,
      timestamp: new Date(),
      isOwn,
    };
    // Create new object references to ensure Svelte 5 reactivity detects changes deeply
    const updatedConvo = { ...convo, messages: [...convo.messages, newMsg] };

    // Explicitly re-set and re-assign the Map to ensure $derived re-evaluates in Svelte 5
    conversations.set(normalized, updatedConvo);
    conversations = new Map(conversations); // CRITICAL: Trigger reactivity

    saveConversation(normalized);
    tick().then(() => {
      if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
    });
  }

  async function handleSendChat() {
    const text = messageText.trim();
    if (!text || !selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo?.isReady) {
      log("⚠️ La conversation n'est pas encore chiffrée.");
      return;
    }

    // Clear input immediately to prevent double sends
    messageText = "";

    try {
      const encryptedBytes = await mls.sendMessage(convo.groupId, text);

      // Save state immediately after sending message to update sender ratchet!
      try {
        const stateBytes = await mls.saveState(pin);
        const hex = toHex(stateBytes);
        localStorage.setItem("mls_autosave_" + userId, hex);
      } catch (saveErr) {
        log(`Avertissement: sauvegarde état échouée: ${saveErr}`);
      }

      addMessageToChat(userId, text, true, selectedContact);
      log(`↗️ Message chiffré envoyé (${encryptedBytes.length} bytes)`);
    } catch (e: any) {
      log(`Erreur envoi: ${e}`);
      // Restore message on failure
      messageText = text;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendChat();
    }
  }

  function logout() {
    isLoggedIn = false;
    isWsConnected = false;
    conversations = new Map();
    selectedContact = null;
    statusLog = [];
  }

  function resetAll() {
    localStorage.clear();
    logout();
    log("⚡ État réinitialisé.");
  }

  // Dev tools
  async function devGenerateKeyPackage() {
    try {
      const bytes = await mls.generateKeyPackage(pin);
      lastKeyPackage = toHex(bytes);
      log(`KeyPackage généré (${bytes.length} bytes).`);
    } catch (e: any) {
      log(`Erreur GenKeyPackage: ${e}`);
    }
  }

  async function devAddMember() {
    if (!selectedContact || !incomingBytesHex) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    try {
      const kpBytes = fromHex(incomingBytesHex);
      const result = await mls.addMember(convo.groupId, kpBytes);
      lastCommit = toHex(result.commit);
      if (result.welcome) lastWelcome = toHex(result.welcome);
      incomingBytesHex = "";
      log("Membre ajouté.");
    } catch (e: any) {
      log(`Erreur AddMember: ${e}`);
    }
  }

  async function devProcessWelcome() {
    if (!incomingBytesHex) return;
    try {
      const welcomeBytes = fromHex(incomingBytesHex);
      const gid = await mls.processWelcome(welcomeBytes);
      log(`Groupe rejoint: ${gid}`);
      incomingBytesHex = "";
    } catch (e: any) {
      log(`Erreur ProcessWelcome: ${e}`);
    }
  }

  $effect(() => {
    if (selectedContact && chatContainer) {
      tick().then(() => {
        if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
      });
    }
  });
</script>

<!-- ==================== TEMPLATE ==================== -->

{#if !isLoggedIn}
  <!-- ========== LOGIN SCREEN ========== -->
  <div class="login-screen">
    <div class="login-card">
      <div class="login-header">
        <div class="app-icon">💬</div>
        <h1>Messagerie Sécurisée</h1>
        <p class="subtitle">Chiffrement de bout en bout via MLS</p>
      </div>

      <div class="login-form">
        <label for="userId">Votre pseudonyme</label>
        <input
          id="userId"
          type="text"
          bind:value={userId}
          placeholder="Ex: alice"
          onkeydown={(e) => e.key === "Enter" && !isLoggingIn && handleLogin()}
        />

        <label for="pin">PIN de chiffrement</label>
        <input
          id="pin"
          type="password"
          bind:value={pin}
          placeholder="1234"
          onkeydown={(e) => e.key === "Enter" && !isLoggingIn && handleLogin()}
        />

        <button
          class="btn-primary btn-full"
          onclick={handleLogin}
          disabled={isLoggingIn}
        >
          {#if isLoggingIn}
            <span class="spinner"></span> Initialisation...
          {:else}
            Se connecter
          {/if}
        </button>

        {#if loginError}
          <div class="error-msg">{loginError}</div>
        {/if}

        <button class="btn-danger btn-small" onclick={resetAll}>
          🗑️ Effacer les données locales
        </button>
      </div>

      {#if statusLog.length > 0}
        <div class="login-logs" id="logContainer">
          {#each statusLog as entry}
            <div class="log-line">{entry}</div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{:else}
  <!-- ========== CHAT APP ========== -->
  <div class="app">
    <!-- TOP BAR -->
    <header class="topbar">
      <div class="topbar-left">
        <span class="app-name">Canari</span>
      </div>
      <div class="topbar-center">
        <span class="conn-dot {isWsConnected ? 'dot-on' : 'dot-off'}"></span>
        <span class="username"
          >Connecté en tant que <strong>{userId}</strong></span
        >
      </div>
      <div class="topbar-right">
        <button
          class="btn-icon"
          onclick={() => (showLogs = !showLogs)}
          title="Logs techniques"
        >
          📋 Logs
        </button>
        <button
          class="btn-icon btn-danger-icon"
          onclick={logout}
          title="Déconnexion"
        >
          🚪 Déconnexion
        </button>
      </div>
    </header>

    <div class="main-area">
      <!-- SIDEBAR: Contact list -->
      <aside class="sidebar">
        <div class="sidebar-title">Discussions</div>

        <div class="contacts-list">
          {#each Array.from(conversations.entries()) as [name, convo]}
            <button
              class="contact-item {selectedContact === name
                ? 'contact-selected'
                : ''}"
              onclick={() => (selectedContact = name)}
            >
              <div class="contact-avatar">{(convo.name || name)[0].toUpperCase()}</div>
              <div class="contact-info">
                <div class="contact-name">{convo.name || name}</div>
                <div class="contact-preview">
                  {#if convo.isReady}
                    {#if convo.messages.length > 0}
                      {convo.messages[
                        convo.messages.length - 1
                      ].content.substring(0, 30)}
                    {:else}
                      Chiffrement actif 🔒
                    {/if}
                  {:else}
                    En attente d'échange de clés... ⏳
                  {/if}
                </div>
              </div>
              {#if !convo.isReady}
                <span class="pending-dot"></span>
              {/if}
            </button>
          {/each}

          {#if conversations.size === 0}
            <div class="empty-hint">
              <span style="font-size: 2em; display:block; margin-bottom: 10px;"
                >👋</span
              >
              Aucune discussion.<br />Commencez par ajouter un contact.
            </div>
          {/if}
        </div>

        <!-- Add contact form -->
        <div class="add-contact-box">
          <div class="add-contact-label">Nouveau contact</div>
          <div class="add-contact-row">
            <input
              type="text"
              bind:value={newContactInput}
              placeholder="Ex: jolan"
              onkeydown={(e) => {
                if (e.key === "Enter" && newContactInput.trim()) {
                  startNewConversation(newContactInput);
                  newContactInput = "";
                }
              }}
            />
            <button
              class="btn-add"
              onclick={() => {
                if (newContactInput.trim()) {
                  startNewConversation(newContactInput);
                  newContactInput = "";
                }
              }}
              disabled={isAddingContact}
              title="Démarrer la conversation"
            >
              +
            </button>
          </div>
        </div>

        <!-- Add Group form -->
        <div class="add-contact-box">
            <div class="add-contact-label">Nouveau Groupe</div>
            <div class="add-contact-row">
                <input
                    type="text"
                    bind:value={newGroupInput}
                    placeholder="Nom du groupe"
                    onkeydown={(e) => {
                        if (e.key === "Enter" && newGroupInput.trim()) {
                            createNewGroup(newGroupInput);
                            newGroupInput = "";
                        }
                    }}
                />
                <button
                    class="btn-add"
                    onclick={() => {
                        if (newGroupInput.trim()) {
                            createNewGroup(newGroupInput);
                            newGroupInput = "";
                        }
                    }}
                    title="Créer"
                >
                    +
                </button>
            </div>
        </div>
      </aside>

      <!-- CHAT AREA -->
      <main class="chat-area">
        {#if !selectedContact}
          <!-- No conversation selected -->
          <div class="chat-empty">
            <div class="chat-empty-icon">🔐</div>
            <h2>Sélectionnez une discussion</h2>
            <p>Vos messages sont chiffrés de bout en bout (MLS).</p>
          </div>
        {:else}
          <!-- Chat header -->
          <div class="chat-header">
            <div class="chat-header-left">
                <div class="chat-header-avatar">
                {selectedContact[0].toUpperCase()}
                </div>
                <div class="chat-header-info">
                <div class="chat-header-name">{currentConvo?.name || selectedContact}</div>
                {#if currentConvo?.isReady}
                    <div class="chat-header-status status-ready">
                    🔒 Chiffrement E2E actif et vérifié
                    </div>
                {:else}
                    <div class="chat-header-status status-pending">
                    ⏳ En attente de {selectedContact}...
                    </div>
                {/if}
                </div>
            </div>

            <div class="chat-header-right">
                 <input 
                    type="text" 
                    class="invite-input"
                    bind:value={inviteMemberInput} 
                    placeholder="Inviter..." 
                    onkeydown={(e) => {
                        if (e.key === "Enter" && inviteMemberInput.trim()) {
                            inviteMemberToCurrentGroup(inviteMemberInput);
                            inviteMemberInput = "";
                        }
                    }}
                />
                 <button 
                    class="btn-invite" 
                    onclick={() => {
                        if (inviteMemberInput.trim()) {
                            inviteMemberToCurrentGroup(inviteMemberInput);
                            inviteMemberInput = "";
                        }
                    }}>
                    + Inviter
                </button>
            </div>
          </div>

          <!-- Messages -->
          <div class="messages" bind:this={chatContainer}>
            {#if !currentMessages.length && !currentConvo?.isReady}
              <div class="waiting-message">
                <div class="waiting-card">
                  <div style="font-size:2.5em;margin-bottom:12px">⏳</div>
                  <strong>Préparation de la connexion sécurisée...</strong>
                  <p>
                    L'application établit le protocole MLS avec <strong
                      >{selectedContact}</strong
                    >.
                  </p>
                  <p style="font-size: 0.85em; color: #666; margin-top: 15px;">
                    Assurez-vous que {selectedContact} est connecté et a ouvert la
                    conversation avec vous.
                  </p>
                </div>
              </div>
            {:else if !currentMessages.length}
              <div class="no-messages">
                <span style="font-size: 2em; display:block; margin-bottom: 8px;"
                  >✨</span
                >
                La connexion est sécurisée.<br />Vous pouvez commencer à
                discuter !
              </div>
            {/if}

            {#each currentMessages as msg (msg.id)}
              <div class="msg-wrapper {msg.isOwn ? 'msg-own' : 'msg-other'}">
                {#if !msg.isOwn}
                  <div class="msg-avatar" title={msg.senderId}>
                    {msg.senderId[0].toUpperCase()}
                  </div>
                {/if}
                <div
                  class="msg-bubble {msg.isOwn ? 'bubble-own' : 'bubble-other'}"
                >
                  <div class="msg-text">{msg.content}</div>
                  <div class="msg-time">{format(msg.timestamp, "HH:mm")}</div>
                </div>
              </div>
            {/each}
          </div>

          <!-- Input area -->
          <div class="input-area">
            {#if !currentConvo?.isReady}
              <div class="input-waiting">
                ⏳ Clés de chiffrement en cours de génération... Veuillez
                patienter.
              </div>
            {:else}
              <textarea
                class="msg-input"
                bind:value={messageText}
                placeholder="Écrivez un message sécurisé... (Entrée pour envoyer)"
                rows="1"
                onkeydown={handleKeydown}
              ></textarea>
              <button
                class="btn-send"
                onclick={handleSendChat}
                disabled={!messageText.trim()}
                title="Envoyer le message"
                aria-label="Envoyer le message"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M2.01 21L23 12L2.01 3L2 10L17 12L2 14L2.01 21Z"
                    fill="currentColor"
                  />
                </svg>
              </button>
            {/if}
          </div>
        {/if}
      </main>

      <!-- LOGS PANEL (toggleable) -->
      {#if showLogs}
        <aside class="logs-panel">
          <div class="logs-title">
            <span>🛠️ Logs & Débogage</span>
            <button class="btn-icon" onclick={() => (showLogs = false)}
              >✕</button
            >
          </div>
          <div class="logs-content" id="logContainer">
            {#each statusLog as entry}
              <div class="log-line">{entry}</div>
            {/each}
          </div>
          <details class="dev-tools">
            <summary>Actions manuelles MLS</summary>
            <div
              style="padding:12px;display:flex;flex-direction:column;gap:8px;"
            >
              <button onclick={devGenerateKeyPackage} class="btn-sm"
                >Générer KeyPackage</button
              >
              {#if lastKeyPackage}
                <textarea
                  rows="2"
                  readonly
                  value={lastKeyPackage}
                  onclick={(e) => e.currentTarget.select()}
                ></textarea>
              {/if}
              <textarea
                rows="2"
                bind:value={incomingBytesHex}
                placeholder="Coller Hex (KeyPackage ou Welcome)"
              ></textarea>
              <button onclick={devAddMember} class="btn-sm"
                >Ajouter Membre</button
              >
              <button onclick={devProcessWelcome} class="btn-sm"
                >Rejoindre (Welcome)</button
              >
            </div>
          </details>
        </aside>
      {/if}
    </div>
  </div>
{/if}

<!-- ==================== STYLES ==================== -->
<style>
  :global(body) {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      Helvetica, Arial, sans-serif;
    background: #f0f2f5;
    height: 100vh;
    overflow: hidden;
  }

  /* ===== LOGIN ===== */
  .login-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    background: #f0f2f5;
  }
  .login-card {
    background: white;
    border-radius: 12px;
    padding: 40px;
    width: 380px;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  }
  .login-header {
    text-align: center;
    margin-bottom: 30px;
  }
  .app-icon {
    font-size: 3.5em;
    margin-bottom: 12px;
  }
  .login-header h1 {
    margin: 0;
    font-size: 1.6em;
    color: #111827;
    font-weight: 800;
  }
  .subtitle {
    color: #6b7280;
    font-size: 0.9em;
    margin: 8px 0 0 0;
  }
  .login-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .login-form label {
    font-weight: 600;
    font-size: 0.85em;
    color: #374151;
    margin-top: 4px;
    margin-bottom: -4px;
  }
  .login-form input {
    padding: 12px 16px;
    border: 1.5px solid #d1d5db;
    border-radius: 10px;
    font-size: 1em;
    transition: all 0.2s;
    outline: none;
    width: 100%;
    box-sizing: border-box;
    background: #f9fafb;
  }
  .login-form input:focus {
    border-color: #facc15;
    background: white;
    box-shadow: 0 0 0 3px rgba(250, 204, 21, 0.15);
  }
  .login-logs {
    margin-top: 20px;
    background: #111827;
    border-radius: 10px;
    padding: 12px;
    max-height: 140px;
    overflow-y: auto;
    font-size: 0.75em;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
      monospace;
    color: #10b981;
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.5);
  }
  .error-msg {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #b91c1c;
    border-radius: 10px;
    padding: 10px 14px;
    font-size: 0.85em;
    text-align: center;
  }

  /* ===== BUTTONS ===== */
  .btn-primary {
    background: #facc15;
    color: #111827;
    border: none;
    border-radius: 8px;
    padding: 14px;
    font-size: 1.05em;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.2s;
  }
  .btn-primary:hover:not(:disabled) {
    background: #eab308;
  }
  .btn-primary:active:not(:disabled) {
    transform: translateY(1px);
  }
  .btn-primary:disabled {
    background: #fef08a;
    color: #9ca3af;
    cursor: not-allowed;
  }
  .btn-full {
    width: 100%;
    margin-top: 12px;
  }
  .btn-danger {
    background: transparent;
    color: #ef4444;
    border: 1px solid #fca5a5;
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 0.8em;
    font-weight: 500;
    cursor: pointer;
    margin-top: 12px;
    transition: all 0.2s;
  }
  .btn-danger:hover {
    background: #fef2f2;
  }
  .btn-small {
    padding: 8px 12px;
    font-size: 0.85em;
  }
  .btn-sm {
    padding: 8px 12px;
    font-size: 0.85em;
    border: 1px solid #4b5563;
    border-radius: 6px;
    cursor: pointer;
    background: #374151;
    color: white;
    font-weight: 500;
  }
  .btn-sm:hover {
    background: #4b5563;
  }
  
  /* New Styles */
  .chat-header-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .chat-header-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .invite-input {
    border: 1px solid #d1d5db;
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 0.85em;
    width: 140px;
    outline: none;
    transition: all 0.2s;
  }
  .invite-input:focus {
    border-color: #3b82f6;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
  }
  .btn-invite {
    background: #10b981;
    color: white;
    border: none;
    border-radius: 8px;
    padding: 6px 12px;
    font-size: 0.85em;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .btn-invite:hover {
    background: #059669;
  }

  .spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    vertical-align: middle;
    margin-right: 8px;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* ===== APP LAYOUT ===== */
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  /* ===== TOPBAR ===== */
  .topbar {
    background: #111827;
    color: white;
    padding: 0 24px;
    height: 60px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    z-index: 10;
  }
  .topbar-left {
    display: flex;
    align-items: center;
  }
  .app-name {
    font-size: 1.25em;
    font-weight: 800;
    letter-spacing: 0.5px;
  }
  .topbar-center {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 0.9em;
    color: #9ca3af;
    background: #1f2937;
    padding: 6px 16px;
    border-radius: 20px;
  }
  .topbar-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .conn-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot-on {
    background: #10b981;
    box-shadow: 0 0 8px rgba(16, 185, 129, 0.5);
  }
  .dot-off {
    background: #ef4444;
    box-shadow: 0 0 8px rgba(239, 68, 68, 0.5);
  }
  .username strong {
    color: white;
    font-weight: 600;
  }
  .btn-icon {
    background: transparent;
    border: 1px solid transparent;
    color: #d1d5db;
    font-size: 0.9em;
    font-weight: 500;
    cursor: pointer;
    padding: 6px 12px;
    border-radius: 8px;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .btn-icon:hover {
    background: #374151;
    color: white;
    border-color: #4b5563;
  }
  .btn-danger-icon:hover {
    background: #7f1d1d;
    color: #fecaca;
    border-color: #991b1b;
  }

  /* ===== MAIN AREA ===== */
  .main-area {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  /* ===== SIDEBAR ===== */
  .sidebar {
    width: 320px;
    flex-shrink: 0;
    background: white;
    border-right: 1px solid #e5e7eb;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .sidebar-title {
    padding: 20px 24px 12px;
    font-weight: 700;
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #6b7280;
    background: #f9fafb;
    border-bottom: 1px solid #f3f4f6;
  }
  .contacts-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .contact-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-radius: 12px;
    cursor: pointer;
    width: 100%;
    border: 1px solid transparent;
    background: transparent;
    text-align: left;
    transition: all 0.2s;
    position: relative;
  }
  .contact-item:hover {
    background: #f3f4f6;
  }
  .contact-selected {
    background: #fef9c3 !important;
    border-color: #facc15;
  }
  .contact-avatar {
    width: 46px;
    height: 46px;
    border-radius: 12px;
    background: #facc15;
    color: #111827;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-size: 1.2em;
  }
  .contact-info {
    flex: 1;
    min-width: 0;
  }
  .contact-name {
    font-weight: 600;
    font-size: 1.05em;
    color: #111827;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 2px;
  }
  .contact-preview {
    font-size: 0.85em;
    color: #6b7280;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pending-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #f59e0b;
    flex-shrink: 0;
    box-shadow: 0 0 0 2px white;
  }
  .empty-hint {
    text-align: center;
    color: #9ca3af;
    font-size: 0.9em;
    padding: 30px 20px;
    line-height: 1.6;
    margin: 0;
  }
  .add-contact-box {
    padding: 16px;
    border-top: 1px solid #e5e7eb;
    background: #f9fafb;
  }
  .add-contact-label {
    font-size: 0.8em;
    font-weight: 700;
    color: #4b5563;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 10px;
  }
  .add-contact-row {
    display: flex;
    gap: 10px;
  }
  .add-contact-row input {
    flex: 1;
    padding: 10px 14px;
    border: 1px solid #d1d5db;
    border-radius: 10px;
    font-size: 0.95em;
    outline: none;
    transition: all 0.2s;
  }
  .add-contact-row input:focus {
    border-color: #facc15;
    box-shadow: 0 0 0 2px rgba(250, 204, 21, 0.2);
  }
  .btn-add {
    width: 42px;
    height: 42px;
    background: #facc15;
    color: #111827;
    border: none;
    border-radius: 10px;
    font-size: 1.4em;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all 0.2s;
  }
  .btn-add:hover:not(:disabled) {
    background: #eab308;
    transform: translateY(-1px);
  }
  .btn-add:disabled {
    background: #fef08a;
    color: #9ca3af;
    cursor: not-allowed;
    transform: none;
  }

  /* ===== CHAT AREA ===== */
  .chat-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #f8fafc;
    position: relative;
  }
  .chat-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #6b7280;
    gap: 12px;
  }
  .chat-empty-icon {
    font-size: 5em;
    opacity: 0.8;
  }
  .chat-empty h2 {
    margin: 0;
    font-size: 1.4em;
    color: #111827;
    font-weight: 700;
  }
  .chat-empty p {
    margin: 0;
    font-size: 1em;
  }

  .chat-header {
    background: white;
    padding: 16px 24px;
    border-bottom: 1px solid #e5e7eb;
    display: flex;
    align-items: center;
    gap: 16px;
    flex-shrink: 0;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
    z-index: 5;
  }
  .chat-header-avatar {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    background: #facc15;
    color: #111827;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.3em;
  }
  .chat-header-name {
    font-weight: 800;
    font-size: 1.2em;
    color: #111827;
    margin-bottom: 2px;
  }
  .chat-header-status {
    font-size: 0.85em;
    font-weight: 500;
  }
  .status-ready {
    color: #059669;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .status-pending {
    color: #d97706;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .messages {
    flex: 1;
    padding: 24px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .waiting-message {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .waiting-card {
    background: white;
    border-radius: 16px;
    padding: 32px 40px;
    text-align: center;
    box-shadow:
      0 4px 6px -1px rgba(0, 0, 0, 0.05),
      0 2px 4px -1px rgba(0, 0, 0, 0.03);
    max-width: 400px;
    border: 1px solid #f3f4f6;
    color: #4b5563;
    font-size: 1em;
    line-height: 1.6;
  }
  .waiting-card strong {
    color: #111827;
    font-size: 1.1em;
    display: block;
    margin-bottom: 8px;
  }
  .no-messages {
    text-align: center;
    color: #6b7280;
    font-size: 1em;
    margin-top: 60px;
    background: white;
    padding: 24px;
    border-radius: 16px;
    max-width: 300px;
    margin-left: auto;
    margin-right: auto;
    border: 1px dashed #e5e7eb;
  }

  .msg-wrapper {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    margin-bottom: 4px;
  }
  .msg-own {
    flex-direction: row-reverse;
  }
  .msg-other {
    flex-direction: row;
  }
  .msg-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: #e5e7eb;
    color: #4b5563;
    font-size: 0.85em;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  }
  .msg-bubble {
    max-width: 65%;
    padding: 12px 16px;
    border-radius: 18px;
    word-break: break-word;
    position: relative;
  }
  .bubble-own {
    background: #facc15;
    color: #111827;
    border-bottom-right-radius: 4px;
  }
  .bubble-own .msg-time {
    color: rgba(17, 24, 39, 0.7);
  }
  .bubble-other {
    background: white;
    color: #111827;
    border-bottom-left-radius: 4px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
    border: 1px solid #f3f4f6;
  }
  .msg-text {
    font-size: 1em;
    line-height: 1.5;
  }
  .msg-time {
    font-size: 0.75em;
    margin-top: 6px;
    text-align: right;
    opacity: 0.8;
  }
  .bubble-other .msg-time {
    color: #9ca3af;
  }

  .input-area {
    padding: 16px 24px;
    background: white;
    border-top: 1px solid #e5e7eb;
    display: flex;
    align-items: flex-end;
    gap: 12px;
    z-index: 5;
  }
  .input-waiting {
    flex: 1;
    text-align: center;
    color: #b45309;
    background: #fef3c7;
    border: 1px solid #fde68a;
    border-radius: 12px;
    padding: 14px;
    font-size: 0.95em;
    font-weight: 500;
  }
  .msg-input {
    flex: 1;
    padding: 14px 18px;
    background: #f3f4f6;
    border: 1px solid transparent;
    border-radius: 20px;
    font-size: 1em;
    resize: none;
    outline: none;
    max-height: 120px;
    overflow-y: auto;
    font-family: inherit;
    transition: all 0.2s;
    line-height: 1.5;
  }
  .msg-input:focus {
    background: white;
    border-color: #facc15;
    box-shadow: 0 0 0 3px rgba(250, 204, 21, 0.15);
  }
  .btn-send {
    width: 50px;
    height: 50px;
    background: #facc15;
    color: #111827;
    border: none;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all 0.2s;
  }
  .btn-send svg {
    width: 22px;
    height: 22px;
    margin-left: 2px;
  }
  .btn-send:hover:not(:disabled) {
    background: #eab308;
    transform: scale(1.02);
  }
  .btn-send:active:not(:disabled) {
    transform: scale(0.98);
  }
  .btn-send:disabled {
    background: #fef08a;
    color: #9ca3af;
    cursor: not-allowed;
  }

  /* ===== LOGS PANEL ===== */
  .logs-panel {
    width: 360px;
    flex-shrink: 0;
    background: #111827;
    border-left: 1px solid #374151;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .logs-title {
    padding: 16px 20px;
    background: #1f2937;
    color: #e5e7eb;
    font-size: 0.85em;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
    border-bottom: 1px solid #374151;
  }
  .logs-content {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
      monospace;
    font-size: 0.75em;
    color: #10b981;
    line-height: 1.6;
  }
  .log-line {
    padding: 4px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    word-break: break-all;
  }
  .log-line:last-child {
    border-bottom: none;
  }
  .dev-tools {
    border-top: 1px solid #374151;
    font-size: 0.85em;
    color: #d1d5db;
    background: #1f2937;
  }
  .dev-tools summary {
    padding: 14px 20px;
    cursor: pointer;
    font-weight: 600;
  }
  .dev-tools textarea {
    background: #111827;
    color: #e5e7eb;
    border: 1px solid #4b5563;
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 0.9em;
    width: 100%;
    box-sizing: border-box;
    font-family: monospace;
    outline: none;
  }
  .dev-tools textarea:focus {
    border-color: #facc15;
  }
</style>
