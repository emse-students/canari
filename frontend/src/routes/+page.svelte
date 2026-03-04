<script lang="ts">
  import { TauriMlsService, WebMlsService } from '$lib/mlsService';
  import type { IMlsService } from '$lib/mlsService';
  import { onMount } from 'svelte';

  // --- State (Runes) ---
  let userId = $state("Alice");
  let pin = $state("1234");
  let isLoggedIn = $state(false);
  let statusLog = $state<string[]>([]);
  
  let groupId = $state("TestGroup");
  let messageText = $state("Hello MLS!");

  // Key Package & Welcome (for manual copy-paste simulation)
  let lastKeyPackage = $state("");
  let lastCommit = $state("");
  let lastWelcome = $state(""); // Added
  let incomingBytesHex = $state("");

  // Service
  let mls: IMlsService; // Using interface

  onMount(() => {
    // --- WASM LOG BINDING ---
    // Expose log function to window for Rust WASM to call
    (window as any).wasm_bindings_log = (level: string, msg: string) => {
       log(`[RUST::${level}] ${msg}`);
    };

    // Check if running in Tauri context or browser
    if (window.__TAURI_INTERNALS__) {
      mls = new TauriMlsService();
      log("Initialized in TAURI mode");
    } else {
      mls = new WebMlsService();
      log("Initialized in WEB (WASM) mode");
    }
  });

  function log(msg: string) {
    // Svelte 5: Reassign to trigger update
    statusLog = [...statusLog, `[${new Date().toLocaleTimeString()}] ${msg}`];
  }

  async function generateDevToken(uid: string) {
    // Secret from chat-gateway/src/main.rs (dev only)
    const secret = "9a2f8c4e6b0d71f3e8b925b1234567890abcdef1234567890abcdef12345678";
    const header = JSON.stringify({ alg: "HS256", typ: "JWT" });
    const payload = JSON.stringify({ sub: uid, exp: Math.floor(Date.now() / 1000) + 3600 * 24 });
    
    // Base64Url encode
    const b64url = (str: string) => btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    
    const unsignedToken = `${b64url(header)}.${b64url(payload)}`;
    
    // Sign
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, enc.encode(unsignedToken));
    const sigB64 = b64url(String.fromCharCode(...new Uint8Array(signature)));
    
    return `${unsignedToken}.${sigB64}`;
  }

  // --- Auth ---
  async function handleLogin() {
    console.log("handleLogin called");
    try {
      if (!mls) {
        log("MLS Service not initialized");
        return;
      }
      log("Initializing...");

      // Attempt to load from localStorage (autosave) or standard save
      let stateBytes: Uint8Array | undefined;
      const saved = localStorage.getItem('mls_autosave_' + userId);
      if (saved) {
        // Convert hex to bytes
        const len = saved.length;
        const bytes = new Uint8Array(len / 2);
        for (let i = 0; i < len; i += 2) {
          bytes[i / 2] = parseInt(saved.substring(i, i + 2), 16);
        }
        stateBytes = bytes;
        log("Loaded autosaved state.");
      }

      await mls.init(userId, pin, stateBytes);
      isLoggedIn = true;
      log(`Logged in as ${userId}`);
      
      // Connect to Gateway
      const token = await generateDevToken(userId);
      await mls.connect(token);
      
      // Setup listener
      mls.onMessage(async (sender, content) => {
          log(`Received message from ${sender} (${content.length} bytes)`);
          // Try to process as incoming MLS message
          try {
              // Note: Ideally we should differentiate between Welcome, Commit, Application, etc.
              // But processIncomingMessage might handle Application/Handshake.
              // However, typically Welcome messages are handled separately via processWelcome...
              // If the content starts with specific bytes, maybe we can guess?
              // Or we try processIncomingMessage first.
              const decrypted = await mls.processIncomingMessage(groupId, content);
              if (decrypted) {
                  log(`DECRYPTED: ${decrypted}`);
              } else {
                  // It was a handshake message (likely Commit/Proposal) processed successfully
                  log(`Processed handshake message.`);
              }
          } catch (e) {
              // If it fails, maybe it's a Welcome message?
              // The backend treats all messages as "MlsMessage".
              // If we are invited, the message usually comes differently or via the same channel?
              // For a new member, they are not in the group yet, so they wouldn't receive group messages easily 
              // unless they are delivered directly.
              // Here we assume broadcast.
              log(`Process error: ${e}`);
              
              // Try as Welcome?
              try {
                  const joinedGroupId = await mls.processWelcome(content);
                  log(`Processed WELCOME! Joined group: ${joinedGroupId}`);
                  groupId = joinedGroupId; // Update UI
              } catch (e2) {
                  // Ignore
              }
          }
      });
      
    } catch (e: any) {
      console.error(e);
      log(`Login error: ${e.message || e}`); // Improved logging
    }
  }

  // --- Actions ---
  async function createGroup() {
    try {
      await mls.createGroup(groupId);
      log(`Group '${groupId}' created.`);
    } catch (e: any) {
      log(`Create Group error: ${e}`);
    }
  }

  async function generateKeyPackage() {
    try {
      const bytes = await mls.generateKeyPackage(pin);
      lastKeyPackage = toHex(bytes);
      log(`Key Package generated (${bytes.length} bytes). Copy this to another client.`);
    } catch (e: any) {
      log(`Gen KeyPackage error: ${e}`);
    }
  }

  async function addMember() {
    try {
      if (!incomingBytesHex) {
        log("Paste a KeyPackage Hex first!");
        return;
      }
      // Convert hex to bytes
      const kpBytes = fromHex(incomingBytesHex);
      const result = await mls.addMember(groupId, kpBytes);
      
      log(`Member added.`);
      lastCommit = toHex(result.commit);
      if (result.welcome) {
          lastWelcome = toHex(result.welcome);
          log(`Welcome message generated! Copy it to the new member.`);
      }
      
      incomingBytesHex = ""; // Clear input
    } catch (e: any) {
      log(`Add Member error: ${e}`);
    }
  }
  
  async function processWelcome() {
     try {
        if (!incomingBytesHex) {
            log("Paste Welcome Hex first!");
            return;
        }
        const welcomeBytes = fromHex(incomingBytesHex);
        const gid = await mls.processWelcome(welcomeBytes);
        log(`Joined group: ${gid}`);
        groupId = gid;
        incomingBytesHex = "";
     } catch (e: any) {
         log(`Process Welcome error: ${e}`);
     }
  }

  async function sendMessage() {
    try {
      const encrypted = await mls.sendMessage(groupId, messageText);
      log(`Message sent! Encrypted bytes (hex):`);
      log(toHex(encrypted));
    } catch (e: any) {
      log(`Send Message error: ${e}`);
    }
  }
  
  async function receiveMessage() {
     try {
        if (!incomingBytesHex) { return; }
        const bytes = fromHex(incomingBytesHex);
        const result = await mls.processIncomingMessage(groupId, bytes);
        if (result) {
            log(`RECEIVED MESSAGE: ${result}`); // Result is string? Rust returns buffer or string?
            // Rust returns Option<Vec<u8>>. Wait.
            // Tauri command 'recevoir_message' returns ???
            // Let's check TauriMlsService -> invoke<string | null>
            // Rust: returns Result<Option<Vec<u8>>>? No, let's check lib.rs
        } else {
            log(`Processed protocol message (Commit/Proposal/etc) - State Updated`);
        }
        incomingBytesHex = "";
     } catch(e: any) {
        log(`Receive Error: ${e}`);
     }
  }

  // --- Utils ---
  function toHex(buffer: Uint8Array): string {
    return Array.from(buffer).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  
  function fromHex(hex: string): Uint8Array {
      const clean = hex.replace(/\s+/g, '').replace(/[^0-9a-fA-F]/g, '');
      const match = clean.match(/.{1,2}/g);
      if (!match) return new Uint8Array();
      return new Uint8Array(match.map((byte) => parseInt(byte, 16)));
  }

</script>

<style>
  .container { max-width: 800px; margin: 0 auto; padding: 20px; font-family: sans-serif; }
  .box { border: 1px solid #ccc; padding: 15px; margin-bottom: 15px; border-radius: 8px; }
  .log { background: #f0f0f0; padding: 10px; height: 150px; overflow-y: auto; font-family: monospace; border: 1px solid #999; font-size: 0.9em; }
  input, button, textarea { margin: 5px 0; display: block; width: 100%; box-sizing: border-box; }
  button { cursor: pointer; padding: 8px; background: #007bff; color: white; border: none; border-radius: 4px; margin-bottom: 10px;}
  button:hover { background: #0056b3; }
  label { font-weight: bold; margin-top: 10px; display: block; }
  .row { display: flex; gap: 10px; }
  h1, h2, h3 { color: #333; }
</style>

<div class="container">
  <h1>MLS Mock Auth & Test</h1>

  {#if !isLoggedIn}
    <div class="box">
      <h2>Login (Mock)</h2>
      <label>User ID</label>
      <input type="text" bind:value={userId} placeholder="Enter User ID" />
      <label>PIN (Encryption)</label>
      <input type="password" bind:value={pin} placeholder="Enter PIN" />
      <button onclick={handleLogin}>Initialize MLS</button>
    </div>
  {:else}
    <div class="box">
      <h2>Actions</h2>
      
      <div class="row">
         <div style="flex:1">
            <h3>Group Management</h3>
             <label>Group ID (Target)</label>
             <input type="text" bind:value={groupId} />
             <button onclick={createGroup}>1. Create Group</button>
             <button onclick={generateKeyPackage}>2. Generate Key Package (For Joining)</button>
         </div>
         <div style="flex:1">
            <h3>Messaging</h3>
             <label>Message Content</label>
             <input type="text" bind:value={messageText} />
             <button onclick={sendMessage}>Send Message</button>
         </div>
      </div>
      
      <hr/>
      <h3>Simulation (Hex Exchange)</h3>
      <p>Paste Hex data here (KeyPackage from other client, Welcome message, etc.)</p>
      <textarea rows="3" bind:value={incomingBytesHex} placeholder="Paste Hex here..."></textarea>
      
      <div class="row">
          <button onclick={addMember}>Add Member (Using pasted KeyPackage)</button>
          <button onclick={processWelcome}>Join Group (Using pasted Welcome)</button>
          <button onclick={receiveMessage}>Receive Message (Using pasted Bytes)</button>
      </div>

      {#if lastKeyPackage}
        <label>Generated KeyPackage (Copy to other client):</label>
        <textarea readonly rows="3" value={lastKeyPackage} onclick={(e) => e.currentTarget.select()}></textarea>
      {/if}
       {#if lastCommit}
        <label>Generated Commit (To update group):</label>
        <textarea readonly rows="2" value={lastCommit} onclick={(e) => e.currentTarget.select()}></textarea>
      {/if}
       {#if lastWelcome}
        <label>Generated Welcome (Send to new member):</label>
        <textarea readonly rows="2" value={lastWelcome} style="background: #e6fffa; border-color: #38b2ac;" onclick={(e) => e.currentTarget.select()}></textarea>
      {/if}
      
      <button onclick={() => isLoggedIn = false} style="background: #dc3545; margin-top: 20px;">Logout / Reset</button>

    </div>

    <div class="box">
      <h2>Activity Log</h2>
      <div class="log">
        {#each statusLog as entry}
          <div>{entry}</div>
        {/each}
      </div>
    </div>
  {/if}
</div>
