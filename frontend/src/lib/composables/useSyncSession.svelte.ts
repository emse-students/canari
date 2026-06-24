/**
 * Reactive composable owning all QR-based device-sync session state and logic.
 */
import {
  encodeSyncQrPayload,
  executeBidirectionalSyncRound,
  generateEphemeralPublicKey,
  getSyncSessionState,
  joinSyncSession,
  parseSyncQrPayload,
  startSyncSession,
} from '$lib/sync/syncEngine';
import { createSyncQrDataUrl } from '$lib/sync/qr';
import type { IStorage } from '$lib/db';

/** Dependencies injected into QR sync operations from the parent composable. */
export interface SyncSessionContext {
  /** Base URL of the chat-delivery service (for sync session API calls). */
  historyBaseUrl: string;
  /** Authenticated user's ID. */
  userId: string;
  /** This device's MLS device ID. */
  myDeviceId: string;
  /** User PIN used to encrypt/decrypt the backup payload. */
  pin: string;
  /** Local IndexedDB storage (null until logged in). */
  storage: IStorage | null;
  /** Debug log sink. */
  log: (msg: string) => void;
  /** Reloads conversations from DB after sync completes. */
  loadExistingConversations: () => Promise<void>;
  /** Re-runs pending MLS invitations after sync completes. */
  processDeviceInvitationsLocally: () => Promise<void>;
}

export function useSyncSession() {
  let isSyncSessionOpen = $state(false);
  let syncMode = $state<'offer' | 'join'>('offer');
  let syncJoinPayload = $state('');
  let syncQrPayloadText = $state('');
  let syncQrDataUrl = $state('');
  let syncStatusText = $state('');
  let isSyncSessionBusy = $state(false);
  let isCancelled = false;

  /** Executes one bidirectional sync exchange (upload local messages, download peer messages) then reloads conversations and re-processes invitations. */
  async function runSyncRound(sessionId: string, peerDeviceId: string, ctx: SyncSessionContext) {
    if (!ctx.storage) throw new Error('Stockage local indisponible');

    const result = await executeBidirectionalSyncRound({
      historyBaseUrl: ctx.historyBaseUrl,
      storage: ctx.storage,
      pin: ctx.pin,
      userId: ctx.userId,
      myDeviceId: ctx.myDeviceId,
      peerDeviceId,
      sessionId,
    });

    await ctx.loadExistingConversations();
    await ctx.processDeviceInvitationsLocally();

    ctx.log(
      `[SYNC] Terminée. Envoyés: ${result.uploadedMessageCount}, importés: ${result.importedMessageCount}.`
    );
  }

  /** Creates a new QR sync session (offer side): generates an ephemeral key pair, registers with the server, renders a QR code, then polls until the other device joins and runs the sync round. Times out after 3 minutes. */
  async function handleStartSyncSession(ctx: SyncSessionContext) {
    try {
      isCancelled = false;
      isSyncSessionBusy = true;
      isSyncSessionOpen = true;
      syncMode = 'offer';
      syncStatusText = 'Initialisation de la session QR…';

      const offerPublicKey = generateEphemeralPublicKey();
      const session = await startSyncSession(ctx.historyBaseUrl, {
        userId: ctx.userId,
        deviceId: ctx.myDeviceId,
        offerPublicKey,
      });

      syncQrPayloadText = encodeSyncQrPayload(session.qrPayload);
      syncQrDataUrl = await createSyncQrDataUrl(syncQrPayloadText);
      syncStatusText = 'Session créée. En attente de jonction du second appareil…';

      const waitUntil = Date.now() + 180_000;
      let pollInterval = 1200;
      while (Date.now() < waitUntil) {
        if (isCancelled) return;
        const state = await getSyncSessionState(ctx.historyBaseUrl, {
          sessionId: session.sessionId,
          userId: ctx.userId,
        });
        if (state.state === 'joined' && state.answerDeviceId) {
          syncStatusText = 'Appareil rejoint. Synchronisation bidirectionnelle en cours…';
          await runSyncRound(session.sessionId, state.answerDeviceId, ctx);
          syncStatusText = 'Synchronisation terminée.';
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        // Exponential backoff: 1.2s → 1.8s → 2.7s → 4s → 5s (max)
        pollInterval = Math.min(Math.round(pollInterval * 1.5), 5000);
      }

      throw new Error("Timeout: aucun appareil n'a rejoint la session");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      syncStatusText = `Erreur sync: ${msg}`;
      ctx.log(`[SYNC] Erreur source: ${msg}`);
    } finally {
      isSyncSessionBusy = false;
    }
  }

  /** Switches the sync modal to "join" mode and resets all sync state, ready for the user to paste a QR payload. */
  function openJoinSyncModal() {
    syncMode = 'join';
    syncJoinPayload = '';
    syncQrPayloadText = '';
    syncQrDataUrl = '';
    syncStatusText = '';
    isSyncSessionOpen = true;
  }

  /** Joins an existing QR sync session (answer side): parses the QR payload, registers this device as the answerer, then runs the bidirectional sync round. */
  async function handleConfirmJoinSync(ctx: SyncSessionContext) {
    try {
      isCancelled = false;
      isSyncSessionBusy = true;
      syncStatusText = 'Lecture du payload QR…';

      const payload = parseSyncQrPayload(syncJoinPayload.trim());
      if (payload.userId !== ctx.userId) {
        throw new Error('Le payload appartient à un autre utilisateur');
      }

      const answerPublicKey = generateEphemeralPublicKey();
      const joinRes = await joinSyncSession(ctx.historyBaseUrl, {
        sessionId: payload.sessionId,
        joinToken: payload.joinToken,
        userId: ctx.userId,
        deviceId: ctx.myDeviceId,
        answerPublicKey,
      });

      syncStatusText = 'Session rejointe. Synchronisation bidirectionnelle en cours…';
      await runSyncRound(payload.sessionId, joinRes.offerDeviceId, ctx);
      syncStatusText = 'Synchronisation terminée.';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      syncStatusText = `Erreur sync: ${msg}`;
      ctx.log(`[SYNC] Erreur cible: ${msg}`);
    } finally {
      isSyncSessionBusy = false;
    }
  }

  /** Copies the QR payload text to the clipboard. Falls back to the Web Share API when the Clipboard API is unavailable (e.g. non-secure contexts). */
  async function copySyncPayload() {
    if (!syncQrPayloadText) return;
    const payload = syncQrPayloadText;

    try {
      await navigator.clipboard.writeText(payload);
      syncStatusText = 'Payload copié dans le presse-papiers.';
      return;
    } catch {
      /* fallback below */
    }

    try {
      const textarea = document.createElement('textarea');
      textarea.value = payload;
      textarea.setAttribute('readonly', 'true');
      Object.assign(textarea.style, { position: 'fixed', opacity: '0' });
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const copied = await navigator.clipboard.writeText(payload).then(
        () => true,
        () => false
      );
      document.body.removeChild(textarea);
      if (copied) {
        syncStatusText = 'Payload copié dans le presse-papiers.';
        return;
      }
    } catch {
      /* fallback below */
    }

    if (navigator.share) {
      try {
        await navigator.share({ title: 'Canari Sync QR Payload', text: payload });
        syncStatusText = 'Payload partagé avec succès.';
        return;
      } catch {
        /* user cancelled */
      }
    }

    syncStatusText = 'Impossible de copier automatiquement. Copiez le texte manuellement.';
  }

  /** Closes the sync modal and cancels any in-progress polling. */
  function closeModal() {
    isCancelled = true;
    isSyncSessionOpen = false;
  }

  return {
    get isSyncSessionOpen() {
      return isSyncSessionOpen;
    },
    set isSyncSessionOpen(v) {
      isSyncSessionOpen = v;
    },
    get syncMode() {
      return syncMode;
    },
    get syncJoinPayload() {
      return syncJoinPayload;
    },
    set syncJoinPayload(v) {
      syncJoinPayload = v;
    },
    get syncQrPayloadText() {
      return syncQrPayloadText;
    },
    get syncQrDataUrl() {
      return syncQrDataUrl;
    },
    get syncStatusText() {
      return syncStatusText;
    },
    get isSyncSessionBusy() {
      return isSyncSessionBusy;
    },
    handleStartSyncSession,
    openJoinSyncModal,
    handleConfirmJoinSync,
    copySyncPayload,
    closeModal,
  };
}
