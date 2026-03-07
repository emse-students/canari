<script lang="ts">
  import { TauriMlsService, WebMlsService } from "$lib/mlsService";
  import type { IMlsService } from "$lib/mlsService";
  import { onMount, tick } from "svelte";
  import { format } from "date-fns";
  import { fade, fly, slide } from "svelte/transition";

  // --- Types ---
  interface ChatMessage {
    id: string;
    senderId: string;
    content: string;
    timestamp: Date;
    isOwn: boolean;
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
  let userId = $state("");
  let pin = $state("");
  let isLoggedIn = $state(false);
  let isLoggingIn = $state(false);
  let loginError = $state("");
  let statusLog = $state<string[]>([]);
  let showLogs = $state(false);

  let conversations = $state<Map<string, Conversation>>(new Map());
  let selectedContact = $state<string | null>(null);
  let mobileView = $state<"list" | "chat">("list"); // Gestion responsive

  let newContactInput = $state("");
  let newGroupInput = $state("");
  let inviteMemberInput = $state("");
  let isAddingContact = $state(false);
  let messageText = $state("");
  let chatContainer = $state<HTMLElement>();

  let isWsConnected = $state(false);
  let myDeviceId = $state("");

  // Variables de débogage
  let lastKeyPackage = $state("");
  let incomingBytesHex = $state("");
  let lastCommit = $state("");
  let lastWelcome = $state("");

  // Valeurs dérivées pour rendu réactif
  let currentConvo = $derived(
    selectedContact ? (conversations.get(selectedContact) ?? null) : null,
  );
  let currentMessages = $derived(currentConvo?.messages ?? []);

  // Service MLS
  let mls: IMlsService;

  const historyBaseUrl = (() => {
    const env = import.meta.env.VITE_HISTORY_URL;
    if (env && env.trim()) return env;
    return typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:3001";
  })();

  onMount(() => {
    (window as any).wasm_bindings_log = (level: string, msg: string) => {
      log(`[RUST::${level}] ${msg}`);
    };

    if (window.__TAURI_INTERNALS__) {
      mls = new TauriMlsService();
      log("Initialisé en mode TAURI");
    } else {
      mls = new WebMlsService();
      log("Initialisé en mode WEB (WASM)");
    }
  });

  function log(msg: string) {
    statusLog = [...statusLog, `[${new Date().toLocaleTimeString()}] ${msg}`];
    tick().then(() => {
      const logEl = document.getElementById("logContainer");
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    });
  }

  // --- Auth & Initialisation ---
  async function generateDevToken(uid: string) {
    const secret = "9a2f8c4e6b0d71f3e8b925b1234567890abcdef1234567890abcdef12345678";
    const header = JSON.stringify({ alg: "HS256", typ: "JWT" });
    const payload = JSON.stringify({
      sub: uid,
      exp: Math.floor(Date.now() / 1000) + 3600 * 24,
    });
    const b64url = (str: string) =>
      btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const unsignedToken = `${b64url(header)}.${b64url(payload)}`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, enc.encode(unsignedToken));
    const sigB64 = b64url(String.fromCharCode(...new Uint8Array(signature)));
    return `${unsignedToken}.${sigB64}`;
  }

  async function handleLogin() {
    if (!userId.trim() || !pin.trim()) {
      loginError = "Veuillez remplir tous les champs.";
      return;
    }

    loginError = "";
    isLoggingIn = true;
    userId = userId.trim().toLowerCase();

    try {
      if (!mls) throw new Error("Service non initialisé.");

      log("Initialisation MLS...");
      let stateBytes: Uint8Array | undefined;
      const saved = localStorage.getItem("mls_autosave_" + userId);
      if (saved) {
        stateBytes = fromHex(saved);
        log("État chargé depuis le stockage local.");
      }

      await mls.init(userId, pin, stateBytes);
      myDeviceId = mls.getDeviceId();
      log(`Identité MLS initialisée (device: ${myDeviceId})`);

      isLoggedIn = true;
      loadExistingConversations();

      // Listener de messages
      mls.onMessage(async (sender, content, groupId) => {
        log(`Message de ${sender} (${content.length} octets) - Grp: ${groupId}`);
        const senderNorm = sender.toLowerCase();

        let convoKey: string | undefined;
        if (groupId) {
          for (const [k, c] of conversations.entries()) {
            if (c.groupId === groupId) { convoKey = k; break; }
          }
        }
        if (!convoKey && conversations.has(senderNorm)) convoKey = senderNorm;

        if (convoKey) {
          const convo = conversations.get(convoKey)!;
          try {
            const decrypted = await mls.processIncomingMessage(convo.groupId, content);
            try {
              const stBytes = await mls.saveState(pin);
              localStorage.setItem("mls_autosave_" + userId, toHex(stBytes));
            } catch (e) {}

            if (decrypted) addMessageToChat(senderNorm, decrypted, false, convoKey);
            return true;
          } catch (e) {
            log(`Erreur message (groupe connu): ${e}`);
            return false;
          }
        }

        // Si groupe inconnu -> Traitement Welcome
        try {
          const joinedGroupId = await mls.processWelcome(content);
          let groupName = senderNorm;
          
          try {
            const gRes = await fetch(`${historyBaseUrl}/mls-api/groups/${groupId || joinedGroupId}`);
            if (gRes.ok) {
              const gData = await gRes.json();
              if (gData?.name) groupName = gData.name;
            }
          } catch (e) {}

          conversations.set(senderNorm, {
            contactName: senderNorm,
            name: groupName,
            groupId: joinedGroupId,
            messages: [],
            isReady: true,
            mlsStateHex: null,
          });
          conversations = new Map(conversations);
          saveConversation(senderNorm);

          try {
            const stBytes = await mls.saveState(pin);
            localStorage.setItem("mls_autosave_" + userId, toHex(stBytes));
          } catch (e) {}

          log(`✅ Handshake complété avec ${senderNorm}`);
          loadHistoryForConversation(senderNorm, joinedGroupId);
          return true;
        } catch (e2) {
          log(`Ignoré: pas un message pour un groupe existant ni un welcome. ${e2}`);
          return false;
        }
      });

      log("Connexion Gateway...");
      try {
        const token = await generateDevToken(userId);
        await mls.connect(token);
        isWsConnected = true;
        log("Connecté au réseau !");
      } catch (wsErr: any) {
        log(`Gateway inaccessible: ${wsErr.message || wsErr}`);
      }

      try {
        await mls.generateKeyPackage(pin);
        log("KeyPackage publié.");
      } catch (e) {}

    } catch (e: any) {
      loginError = e.message || String(e);
      log(`Erreur: ${loginError}`);
    } finally {
      isLoggingIn = false;
    }
  }

  // --- Utils ---
  function toHex(buffer: Uint8Array): string {
    return Array.from(buffer).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  
  function fromHex(hex: string): Uint8Array {
    const match = hex.match(/.{1,2}/g);
    if (!match) return new Uint8Array();
    return new Uint8Array(match.map((byte) => parseInt(byte, 16)));
  }

  // --- Persistance ---
  function saveConversation(contactName: string) {
    const normalized = contactName.toLowerCase();
    const convo = conversations.get(normalized);
    if (!convo) return;
    localStorage.setItem(
      `conversation:${userId}:${normalized}`,
      JSON.stringify({
        groupId: convo.groupId,
        name: convo.name,
        messages: convo.messages.map((m) => ({ ...m, timestamp: m.timestamp.toISOString() })),
        isReady: convo.isReady,
      })
    );
  }

  async function loadHistoryForConversation(contactName: string, groupId: string) {
    try {
      const history = await mls.fetchHistory(groupId);
      if (history.length > 0) {
        let addedMsg = 0;
        let mlsUpdated = false;

        for (const msg of history) {
          if (msg.sender_id === userId) continue;
          try {
            const bytesStr = atob(msg.content);
            const bytes = new Uint8Array(bytesStr.length);
            for (let i = 0; i < bytesStr.length; i++) bytes[i] = bytesStr.charCodeAt(i);

            const decrypted = await mls.processIncomingMessage(groupId, bytes);
            if (decrypted) {
              addMessageToChat(msg.sender_id, decrypted, false, contactName);
              addedMsg++;
              mlsUpdated = true;
            }
          } catch (err) {}
        }
        if (mlsUpdated) {
          const stateBytes = await mls.saveState(pin);
          localStorage.setItem("mls_autosave_" + userId, toHex(stateBytes));
          log(`✅ ${addedMsg} msg rattrapés pour ${contactName}.`);
        }
      }
    } catch (e: any) {}
  }

  function loadExistingConversations() {
    const prefix = `conversation:${userId}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) {
        const contactName = key.substring(prefix.length).toLowerCase();
        const saved = localStorage.getItem(key);
        if (saved) {
          const data = JSON.parse(saved);
          conversations.set(contactName, {
            contactName,
            name: data.name || contactName,
            groupId: data.groupId,
            messages: (data.messages || []).map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) })),
            isReady: data.isReady || false,
            mlsStateHex: null,
          });
          loadHistoryForConversation(contactName, data.groupId);
        }
      }
    }
  }

  // --- Gestion Groupes & Membres ---
  async function createNewGroup(nameRaw: string) {
    if (!nameRaw.trim()) return;
    const name = nameRaw.trim();
    if (conversations.has(name)) return log(`Groupe "${name}" existe déjà.`);

    try {
      const groupId = await mls.createRemoteGroup(name);
      await mls.createGroup(groupId);
      await mls.registerMember(groupId, userId, mls.getDeviceId());

      // Ajout de ses propres autres appareils (CORRIGÉ)
      const ownDevices = (await mls.fetchUserDevices(userId)).filter((d) => d.deviceId !== mls.getDeviceId());
      for (const device of ownDevices) {
        try {
          const result = await mls.addMember(groupId, device.keyPackage);
          await mls.registerMember(groupId, userId, device.deviceId);
          if (result.welcome) {
            await mls.sendWelcome(result.welcome, userId, groupId, device.deviceId);
          }
          if (result.commit) {
            await mls.sendCommit(result.commit, groupId);
          }
        } catch (e) {
          log(`Erreur synchro propre appareil ${device.deviceId}: ${e}`);
        }
      }

      const stateBytes = await mls.saveState(pin);
      localStorage.setItem("mls_autosave_" + userId, toHex(stateBytes));

      conversations.set(name, {
        contactName: name, name, groupId, messages: [], isReady: true, mlsStateHex: null
      });
      conversations = new Map(conversations);
      
      selectConversation(name);
      saveConversation(name);
      log(`✅ Groupe "${name}" créé!`);
    } catch (e) { log(`Erreur création groupe: ${e}`); }
  }

  async function inviteMemberToCurrentGroup(memberId: string) {
    if (!selectedContact || !memberId.trim()) return;
    const targetUser = memberId.trim().toLowerCase();
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    
    log(`Invitation de ${targetUser}...`);
    try {
      await mls.registerMember(convo.groupId, userId, mls.getDeviceId());
      const devices = await mls.fetchUserDevices(targetUser);
      if (devices.length === 0) return log(`❌ Aucun appareil trouvé pour ${targetUser}.`);

      // Utilisation stricte de l'ajout par lot (CORRIGÉ)
      const bulk = await mls.addMembersBulk(convo.groupId, devices);
      
      for (const did of bulk.addedDeviceIds) {
        await mls.registerMember(convo.groupId, targetUser, did);
      }

      const stateBytes = await mls.saveState(pin);
      localStorage.setItem("mls_autosave_" + userId, toHex(stateBytes));

      if (bulk.welcome) {
        const welcomeB64 = btoa(Array.from(bulk.welcome).map(b => String.fromCharCode(b)).join(''));
        for (const did of bulk.addedDeviceIds) {
          await fetch(`${historyBaseUrl}/mls-api/welcome`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetDeviceId: did, targetUserId: targetUser, senderUserId: userId, welcomePayload: welcomeB64, groupId: convo.groupId }),
          });
        }
      }

      if (bulk.commit) await mls.sendCommit(bulk.commit, convo.groupId);
      
      log(`✅ ${targetUser} invité (${bulk.addedDeviceIds.length}/${devices.length} appareils).`);
    } catch (e) { log(`Erreur invitation: ${e}`); }
  }

  async function startNewConversation(contactNameRaw: string) {
    const contact = contactNameRaw.trim().toLowerCase();
    if (!contact || contact === userId) return;
    
    if (conversations.has(contact)) {
      selectConversation(contact);
      return;
    }

    const groupName = `${userId} & ${contact}`;
    try {
      const groupId = await mls.createRemoteGroup(groupName);
      
      conversations.set(contact, {
        contactName: contact, name: groupName, groupId, messages: [], isReady: false, mlsStateHex: null,
      });
      conversations = new Map(conversations);
      selectConversation(contact);

      await mls.createGroup(groupId);
      await mls.registerMember(groupId, userId, mls.getDeviceId());

      // Synchro de ses autres appareils (CORRIGÉ)
      const ownDevices = (await mls.fetchUserDevices(userId)).filter((d) => d.deviceId !== mls.getDeviceId());
      for (const device of ownDevices) {
        try {
          const result = await mls.addMember(groupId, device.keyPackage);
          await mls.registerMember(groupId, userId, device.deviceId);
          if (result.welcome) await mls.sendWelcome(result.welcome, userId, groupId, device.deviceId);
          if (result.commit) await mls.sendCommit(result.commit, groupId);
        } catch (e) {}
      }

      const stBytes = await mls.saveState(pin);
      localStorage.setItem("mls_autosave_" + userId, toHex(stBytes));

      // Ajout des appareils du contact cible (CORRIGÉ)
      const devices = await mls.fetchUserDevices(contact);
      if (devices.length > 0) {
        const bulk = await mls.addMembersBulk(groupId, devices);
        
        for (const did of bulk.addedDeviceIds) {
          await mls.registerMember(groupId, contact, did);
        }

        const st2Bytes = await mls.saveState(pin);
        localStorage.setItem("mls_autosave_" + userId, toHex(st2Bytes));

        if (bulk.welcome) {
          const welcomeB64 = btoa(Array.from(bulk.welcome).map(b => String.fromCharCode(b)).join(''));
          for (const did of bulk.addedDeviceIds) {
            await fetch(`${historyBaseUrl}/mls-api/welcome`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ targetDeviceId: did, targetUserId: contact, senderUserId: userId, welcomePayload: welcomeB64, groupId }),
            });
          }
        }
        if (bulk.commit) await mls.sendCommit(bulk.commit, groupId);

        const convo = conversations.get(contact)!;
        conversations.set(contact, { ...convo, isReady: true });
        conversations = new Map(conversations);
        saveConversation(contact);
        log(`✅ Canal sécurisé avec ${contact}.`);
      } else {
        log(`❌ Appareils introuvables pour ${contact}.`);
        conversations.delete(contact);
        conversations = new Map(conversations);
      }
    } catch (e: any) { log(`Erreur création: ${e.message}`); }
  }

  // --- Messages & UI ---
  function addMessageToChat(senderId: string, content: string, isOwn: boolean, contactName: string) {
    const normalized = contactName.toLowerCase();
    const convo = conversations.get(normalized);
    if (!convo) return;

    const newMsg: ChatMessage = {
      id: crypto.randomUUID(), senderId: senderId.toLowerCase(), content, timestamp: new Date(), isOwn,
    };
    
    conversations.set(normalized, { ...convo, messages: [...convo.messages, newMsg] });
    conversations = new Map(conversations); 
    saveConversation(normalized);
    
    tick().then(() => { if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight; });
  }

  async function handleSendChat() {
    const text = messageText.trim();
    if (!text || !selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo?.isReady) return;

    messageText = "";
    try {
      await mls.sendMessage(convo.groupId, text);
      const stateBytes = await mls.saveState(pin);
      localStorage.setItem("mls_autosave_" + userId, toHex(stateBytes));
      addMessageToChat(userId, text, true, selectedContact);
    } catch (e: any) {
      log(`Erreur envoi: ${e}`);
      messageText = text;
    }
  }

  function selectConversation(name: string) {
    selectedContact = name;
    mobileView = "chat";
  }

  function goBackToMenu() {
    mobileView = "list";
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
  }

  // --- Outils Dev ---
  async function devGenerateKeyPackage() {
    try {
      const bytes = await mls.generateKeyPackage(pin);
      lastKeyPackage = toHex(bytes);
    } catch (e: any) { log(`Err GenKeyPackage: ${e}`); }
  }
  async function devAddMember() {
    if (!selectedContact || !incomingBytesHex) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    try {
      const result = await mls.addMember(convo.groupId, fromHex(incomingBytesHex));
      lastCommit = toHex(result.commit);
      if (result.welcome) lastWelcome = toHex(result.welcome);
      incomingBytesHex = "";
    } catch (e: any) { log(`Err AddMember: ${e}`); }
  }
  async function devProcessWelcome() {
    if (!incomingBytesHex) return;
    try {
      await mls.processWelcome(fromHex(incomingBytesHex));
      incomingBytesHex = "";
    } catch (e: any) { log(`Err ProcessWelcome: ${e}`); }
  }
</script>

<!-- ==================== UI ==================== -->

{#if !isLoggedIn}
  <div class="login-wrapper" in:fade>
    <div class="login-card">
      <div class="logo-area">
        <div class="canari-box">
          <img src="/favicon.png" alt="Canari Logo" style="width: 60%; height: 60%; object-fit: contain;" />
        </div>
        <h1>Canari</h1>
        <p>Le réseau d'échanges impénétrable.</p>
      </div>

      <div class="login-form">
        <div class="input-group">
          <label for="uid">Nom d'utilisateur</label>
          <input id="uid" type="text" bind:value={userId} placeholder="ex: jolan" onkeydown={(e) => e.key === "Enter" && !isLoggingIn && handleLogin()} />
        </div>
        <div class="input-group">
          <label for="pin">PIN Cryptographique</label>
          <input id="pin" type="password" bind:value={pin} placeholder="••••" onkeydown={(e) => e.key === "Enter" && !isLoggingIn && handleLogin()} />
        </div>

        <button class="btn-login" onclick={handleLogin} disabled={isLoggingIn}>
          {#if isLoggingIn}
            <span class="loader"></span> Démarrage...
          {:else}
            Se connecter
          {/if}
        </button>

        {#if loginError}
          <div class="error-banner" transition:slide>{loginError}</div>
        {/if}
        
        <button class="btn-text-danger" onclick={resetAll}>Réinitialiser l'appareil</button>
      </div>
    </div>
  </div>
{:else}
  <div class="app-layout" in:fade>
    <!-- TOP NAVBAR -->
    <header class="navbar">
      <div class="nav-brand">
        <div class="mini-logo">
          <img src="/favicon.png" alt="Canari" style="width: 70%; height: 70%; object-fit: contain;" />
        </div>
        <span class="brand-text">Canari</span>
      </div>
      
      <div class="nav-status">
        <div class="status-pill {isWsConnected ? 'status-on' : 'status-off'}">
          <span class="dot"></span>
          {isWsConnected ? 'Réseau Connecté' : 'Hors-ligne'}
        </div>
      </div>

      <div class="nav-actions">
        <button class="btn-icon" onclick={() => showLogs = !showLogs} title="Console de logs">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 17l6-6-6-6M12 19h8"/></svg>
        </button>
        <button class="btn-icon btn-logout" onclick={logout} title="Fermer la session">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
        </button>
      </div>
    </header>

    <!-- CONTENT -->
    <main class="main-content">
      <!-- SIDEBAR -->
      <aside class="sidebar {mobileView === 'chat' ? 'hidden-mobile' : ''}">
        <div class="sidebar-header">
          <div class="action-row">
            <input type="text" class="search-input" placeholder="Nouveau contact..." bind:value={newContactInput} onkeydown={(e) => { if (e.key === "Enter" && newContactInput.trim()) { startNewConversation(newContactInput); newContactInput = ""; } }} />
            <button class="btn-plus" title="Ajouter un contact" onclick={() => { if (newContactInput.trim()) { startNewConversation(newContactInput); newContactInput = ""; } }}>👤</button>
          </div>
          <div class="action-row">
            <input type="text" class="search-input" placeholder="Nouveau groupe..." bind:value={newGroupInput} onkeydown={(e) => { if (e.key === "Enter" && newGroupInput.trim()) { createNewGroup(newGroupInput); newGroupInput = ""; } }} />
            <button class="btn-plus" title="Créer un groupe" onclick={() => { if (newGroupInput.trim()) { createNewGroup(newGroupInput); newGroupInput = ""; } }}>👥</button>
          </div>
        </div>
        
        <div class="convo-list">
          {#each Array.from(conversations.entries()) as [name, convo]}
            <button class="convo-tile {selectedContact === name ? 'active' : ''}" onclick={() => selectConversation(name)}>
              <div class="tile-avatar">{name[0].toUpperCase()}</div>
              <div class="tile-info">
                <div class="tile-header">
                  <span class="tile-name">{convo.name}</span>
                  {#if !convo.isReady}<span class="badge-sync">sync</span>{/if}
                </div>
                <div class="tile-preview">
                  {#if convo.messages.length > 0}
                    {convo.messages[convo.messages.length - 1].content}
                  {:else}
                    Canal E2E établi.
                  {/if}
                </div>
              </div>
            </button>
          {/each}

          {#if conversations.size === 0}
            <div class="empty-list">
              <span class="empty-icon">👋</span>
              <p>Votre messagerie est vide. Cherchez un pseudo pour commencer.</p>
            </div>
          {/if}
        </div>
      </aside>

      <!-- CHAT VIEW -->
      <section class="chat-area {mobileView === 'list' ? 'hidden-mobile' : ''}">
        {#if selectedContact}
          <!-- Chat Header -->
          <header class="chat-header">
            <button class="btn-back mobile-only" onclick={goBackToMenu}>
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <div class="chat-avatar">{selectedContact[0].toUpperCase()}</div>
            <div class="chat-meta">
              <h2>{currentConvo?.name}</h2>
              <span class="security-status {currentConvo?.isReady ? 'secure' : 'pending'}">
                {currentConvo?.isReady ? '🔒 Bout-en-bout vérifié' : '⏳ Négociation cryptographique...'}
              </span>
            </div>
            <div class="chat-tools">
               <input type="text" class="invite-field" placeholder="Ajouter au groupe..." bind:value={inviteMemberInput} onkeydown={(e) => { if (e.key === "Enter" && inviteMemberInput.trim()) { inviteMemberToCurrentGroup(inviteMemberInput); inviteMemberInput = ""; } }} />
               <button class="btn-tool" onclick={() => { if (inviteMemberInput.trim()) { inviteMemberToCurrentGroup(inviteMemberInput); inviteMemberInput = ""; } }}>Inviter</button>
            </div>
          </header>

          <!-- Messages -->
          <div class="messages-container" bind:this={chatContainer}>
            {#each currentMessages as msg (msg.id)}
              <div class="msg-row {msg.isOwn ? 'own' : 'other'}">
                <div class="msg-bubble" in:fly={{ y: 5, duration: 200 }}>
                  <p>{msg.content}</p>
                  <span class="msg-time">{format(msg.timestamp, "HH:mm")}</span>
                </div>
              </div>
            {/each}
          </div>

          <!-- Composer -->
          <footer class="chat-composer">
            <div class="composer-box">
              <textarea bind:value={messageText} placeholder="Message sécurisé..." rows="1" onkeydown={handleKeydown}></textarea>
              <button class="btn-send" disabled={!messageText.trim()} onclick={handleSendChat}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M2 21L23 12L2 3V10L17 12L2 14V21Z"/></svg>
              </button>
            </div>
          </footer>
        {:else}
          <div class="empty-chat">
            <div class="big-icon">🔐</div>
            <h2>Aucun échange sélectionné</h2>
            <p>Le réseau Canari protège vos communications avec le protocole MLS.</p>
          </div>
        {/if}
      </section>

      <!-- LOGS PANEL -->
      {#if showLogs}
        <aside class="logs-panel" transition:slide={{ axis: 'x' }}>
          <div class="logs-header">
            <h4>Terminal Système</h4>
            <button class="btn-close" onclick={() => showLogs = false}>×</button>
          </div>
          <div class="logs-body" id="logContainer">
            {#each statusLog as entry}
              <div class="log-entry">{entry}</div>
            {/each}
          </div>
          <details class="logs-dev">
            <summary>Outils Développeur</summary>
            <div class="dev-actions">
              <button onclick={devGenerateKeyPackage}>Générer KeyPackage</button>
              {#if lastKeyPackage}<input type="text" readonly value={lastKeyPackage} />{/if}
              <input type="text" bind:value={incomingBytesHex} placeholder="Payload Hex..." />
              <button onclick={devAddMember}>Ajouter Membre</button>
              <button onclick={devProcessWelcome}>Traiter Welcome</button>
            </div>
          </details>
        </aside>
      {/if}
    </main>
  </div>
{/if}

<style>
  /* --- PALETTE CANARI --- */
  :global(:root) {
    --cn-dark: #111827;      /* Bleu nuit sombre */
    --cn-yellow: #FACC15;    /* Jaune vif */
    --cn-yellow-hover: #EAB308;
    --cn-bg: #F9FAFB;        /* Gris très clair */
    --cn-border: #E5E7EB;
    --text-main: #111827;
    --text-muted: #6B7280;
    --green-ok: #10B981;
    --red-err: #EF4444;
  }

  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--cn-bg);
    color: var(--text-main);
  }

  /* ========== ÉCRAN CONNEXION ========== */
  .login-wrapper {
    height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--cn-bg);
  }
  .login-card {
    background: white; width: 100%; max-width: 380px; padding: 3rem 2.5rem;
    border-radius: 1.5rem; box-shadow: 0 10px 25px rgba(0,0,0,0.05); text-align: center;
  }
  .logo-area { margin-bottom: 2.5rem; }
  .canari-box {
    width: 80px; height: 80px; background: var(--cn-dark); color: var(--cn-yellow);
    border-radius: 1.5rem; display: flex; align-items: center; justify-content: center;
    margin: 0 auto 1.5rem;
  }
  .logo-area h1 { margin: 0; font-size: 2.2rem; font-weight: 900; color: var(--cn-dark); letter-spacing: -0.5px; }
  .logo-area p { color: var(--text-muted); font-size: 0.95rem; margin-top: 0.5rem; }

  .login-form .input-group { text-align: left; margin-bottom: 1.25rem; }
  .input-group label { display: block; font-size: 0.85rem; font-weight: 700; color: var(--cn-dark); margin-bottom: 0.5rem; }
  .input-group input {
    width: 100%; padding: 0.9rem 1rem; border: 1.5px solid var(--cn-border); border-radius: 1rem;
    font-size: 1rem; box-sizing: border-box; outline: none; transition: all 0.2s; background: var(--cn-bg);
  }
  .input-group input:focus { border-color: var(--cn-yellow); background: white; box-shadow: 0 0 0 4px rgba(250,204,21,0.15); }

  .btn-login {
    width: 100%; padding: 1rem; background: var(--cn-yellow); color: var(--cn-dark);
    border: none; border-radius: 1rem; font-weight: 800; font-size: 1.05rem;
    cursor: pointer; transition: transform 0.1s, background 0.2s; margin-top: 0.5rem;
  }
  .btn-login:hover:not(:disabled) { background: var(--cn-yellow-hover); transform: translateY(-2px); }
  .btn-login:active { transform: translateY(0); }
  .btn-login:disabled { opacity: 0.7; cursor: wait; }

  .btn-text-danger {
    background: none; border: none; color: var(--text-muted); font-size: 0.8rem;
    margin-top: 1.5rem; cursor: pointer; text-decoration: underline;
  }
  .btn-text-danger:hover { color: var(--red-err); }

  .error-banner {
    background: #FEF2F2; color: var(--red-err); padding: 0.8rem; border-radius: 0.8rem;
    font-size: 0.9rem; font-weight: 500; margin-top: 1.5rem; border: 1px solid #FECACA;
  }

  .loader {
    display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(17,24,39,0.2);
    border-top-color: var(--cn-dark); border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 8px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ========== APP LAYOUT ========== */
  .app-layout { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

  /* --- NAVBAR --- */
  .navbar {
    height: 64px; background: white; border-bottom: 1px solid var(--cn-border);
    display: flex; align-items: center; justify-content: space-between; padding: 0 1.5rem; z-index: 20;
  }
  .nav-brand { display: flex; align-items: center; gap: 0.75rem; }
  .mini-logo {
    width: 32px; height: 32px; background: var(--cn-dark); color: var(--cn-yellow);
    border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 1.1rem;
  }
  .brand-text { font-weight: 900; font-size: 1.25rem; color: var(--cn-dark); }

  .nav-status { display: flex; align-items: center; }
  .status-pill {
    display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.8rem;
    background: var(--cn-bg); border-radius: 2rem; font-size: 0.75rem; font-weight: 700; color: var(--text-main);
  }
  .status-pill .dot { width: 8px; height: 8px; border-radius: 50%; }
  .status-on .dot { background: var(--green-ok); box-shadow: 0 0 8px rgba(16,185,129,0.5); }
  .status-off .dot { background: var(--text-muted); }

  .nav-actions { display: flex; gap: 0.5rem; }
  .btn-icon { background: none; border: none; padding: 0.5rem; border-radius: 0.5rem; color: var(--text-muted); cursor: pointer; transition: 0.2s; }
  .btn-icon:hover { background: var(--cn-bg); color: var(--cn-dark); }
  .btn-logout:hover { color: var(--red-err); background: #FEF2F2; }

  /* --- MAIN CONTENT --- */
  .main-content { display: flex; flex: 1; overflow: hidden; }

  /* --- SIDEBAR --- */
  .sidebar { width: 340px; background: white; border-right: 1px solid var(--cn-border); display: flex; flex-direction: column; }
  .sidebar-header { padding: 1rem; border-bottom: 1px solid var(--cn-bg); display: flex; flex-direction: column; gap: 0.8rem; }
  .action-row { display: flex; gap: 0.5rem; }
  .search-input {
    flex: 1; padding: 0.7rem 1rem; border: none; background: var(--cn-bg);
    border-radius: 1rem; outline: none; font-size: 0.95rem;
  }
  .search-input:focus { box-shadow: inset 0 0 0 2px var(--cn-yellow); }
  .btn-plus {
    width: 42px; height: 42px; background: var(--cn-dark); color: var(--cn-yellow);
    border: none; border-radius: 1rem; font-size: 1.2rem; cursor: pointer; display: flex; align-items: center; justify-content: center;
  }
  .btn-plus:hover { background: #1F2937; }

  .convo-list { flex: 1; overflow-y: auto; padding: 0.5rem; }
  .convo-tile {
    width: 100%; padding: 0.8rem; display: flex; align-items: center; gap: 1rem;
    border: none; background: none; text-align: left; cursor: pointer; border-radius: 1rem; transition: background 0.1s;
  }
  .convo-tile:hover { background: var(--cn-bg); }
  .convo-tile.active { background: #FEFCE8; }

  .tile-avatar {
    width: 48px; height: 48px; background: var(--cn-yellow); color: var(--cn-dark);
    border-radius: 1.2rem; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 1.2rem; flex-shrink: 0;
  }
  .tile-info { flex: 1; min-width: 0; }
  .tile-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.2rem; }
  .tile-name { font-weight: 700; color: var(--cn-dark); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge-sync { background: #FEF08A; color: #854D0E; font-size: 0.6rem; padding: 0.1rem 0.4rem; border-radius: 1rem; font-weight: 800; text-transform: uppercase; }
  .tile-preview { font-size: 0.85rem; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  
  .empty-list { text-align: center; padding: 2rem 1rem; color: var(--text-muted); }
  .empty-icon { font-size: 2.5rem; display: block; margin-bottom: 1rem; opacity: 0.5; }

  /* --- CHAT AREA --- */
  .chat-area { flex: 1; display: flex; flex-direction: column; background: var(--cn-bg); }
  
  .chat-header {
    background: white; padding: 0.8rem 1.5rem; border-bottom: 1px solid var(--cn-border);
    display: flex; align-items: center; gap: 1rem;
  }
  .chat-avatar {
    width: 42px; height: 42px; background: var(--cn-dark); color: var(--cn-yellow);
    border-radius: 1rem; display: flex; align-items: center; justify-content: center; font-weight: 800; flex-shrink: 0;
  }
  .chat-meta { flex: 1; min-width: 0; }
  .chat-meta h2 { margin: 0 0 0.2rem 0; font-size: 1.1rem; color: var(--cn-dark); }
  .security-status { font-size: 0.75rem; font-weight: 600; }
  .security-status.secure { color: var(--green-ok); }
  .security-status.pending { color: #D97706; }

  .chat-tools { display: flex; gap: 0.5rem; }
  .invite-field { padding: 0.5rem; border: 1px solid var(--cn-border); border-radius: 0.5rem; font-size: 0.85rem; width: 130px; outline:none; }
  .invite-field:focus { border-color: var(--cn-yellow); }
  .btn-tool { background: var(--cn-dark); color: white; border: none; padding: 0.5rem 0.8rem; border-radius: 0.5rem; font-size: 0.85rem; cursor: pointer; font-weight: 600;}
  .btn-tool:hover { background: #1F2937; }

  .messages-container { flex: 1; overflow-y: auto; padding: 1.5rem; display: flex; flex-direction: column; gap: 0.5rem; }
  
  .msg-row { display: flex; width: 100%; }
  .msg-row.own { justify-content: flex-end; }
  .msg-bubble { max-width: 75%; padding: 0.75rem 1.25rem; border-radius: 1.25rem; line-height: 1.4; position: relative; }
  .msg-bubble p { margin: 0; font-size: 0.95rem; word-wrap: break-word; }
  .msg-time { display: block; font-size: 0.65rem; margin-top: 0.4rem; text-align: right; opacity: 0.7; }
  
  .own .msg-bubble { background: var(--cn-yellow); color: var(--cn-dark); border-bottom-right-radius: 0.2rem; }
  .other .msg-bubble { background: white; color: var(--cn-dark); border: 1px solid var(--cn-border); border-bottom-left-radius: 0.2rem; }

  .chat-composer { padding: 1rem 1.5rem; background: white; border-top: 1px solid var(--cn-border); }
  .composer-box { display: flex; align-items: flex-end; gap: 0.8rem; background: var(--cn-bg); padding: 0.6rem 0.8rem; border-radius: 1.5rem; }
  .composer-box textarea {
    flex: 1; background: transparent; border: none; resize: none; outline: none; font-family: inherit; font-size: 1rem; padding: 0.4rem; max-height: 120px;
  }
  .btn-send {
    width: 42px; height: 42px; background: var(--cn-dark); color: var(--cn-yellow);
    border: none; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: 0.2s;
  }
  .btn-send:hover:not(:disabled) { transform: scale(1.05); }
  .btn-send:disabled { opacity: 0.4; cursor: not-allowed; }

  .empty-chat { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-muted); text-align: center; padding: 2rem; }
  .big-icon { font-size: 4rem; margin-bottom: 1rem; opacity: 0.2; }
  .empty-chat h2 { color: var(--cn-dark); margin: 0 0 0.5rem 0; }

  /* --- LOGS PANEL --- */
  .logs-panel { width: 320px; background: #0F172A; color: #10B981; display: flex; flex-direction: column; z-index: 50; border-left: 1px solid #1E293B; }
  .logs-header { padding: 1rem; background: #1E293B; display: flex; justify-content: space-between; align-items: center; color: white; }
  .logs-header h4 { margin: 0; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.5px; }
  .btn-close { background: none; border: none; color: #9CA3AF; font-size: 1.2rem; cursor: pointer; }
  .logs-body { flex: 1; overflow-y: auto; padding: 1rem; font-family: ui-monospace, monospace; font-size: 0.75rem; }
  .log-entry { border-bottom: 1px solid rgba(255,255,255,0.05); padding: 0.4rem 0; word-break: break-all; }
  .logs-dev { background: #1E293B; border-top: 1px solid #334155; color: white; font-size: 0.8rem; }
  .logs-dev summary { padding: 1rem; cursor: pointer; font-weight: bold; }
  .dev-actions { padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .dev-actions button { background: #334155; color: white; border: none; padding: 0.5rem; border-radius: 0.4rem; cursor: pointer; }
  .dev-actions button:hover { background: #475569; }
  .dev-actions input { background: #0F172A; color: white; border: 1px solid #475569; padding: 0.5rem; border-radius: 0.4rem; outline: none; font-family: monospace; }

  .mobile-only { display: none; }

  /* --- RESPONSIVE --- */
  @media (max-width: 768px) {
    .hidden-mobile { display: none !important; }
    .sidebar, .chat-area { width: 100%; flex: 1; }
    .mobile-only { display: block; }
    .chat-tools { display: none; } /* Simplification sur mobile */
    .chat-header { padding: 0.6rem 1rem; }
    .btn-back { margin-right: 0.5rem; color: var(--cn-dark); background: none; border: none; padding: 0.2rem; cursor: pointer; }
    .logs-panel { position: absolute; right: 0; top: 0; bottom: 0; box-shadow: -5px 0 15px rgba(0,0,0,0.2); }
  }
</style>