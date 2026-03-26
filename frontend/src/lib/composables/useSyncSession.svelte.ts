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

export interface SyncSessionContext {
  historyBaseUrl: string;
  userId: string;
  myDeviceId: string;
  pin: string;
  storage: IStorage | null;
  log: (msg: string) => void;
  loadExistingConversations: () => Promise<void>;
  syncOwnDevicesToGroupsLocally: () => Promise<void>;
}

export function useSyncSession() {
  let isSyncSessionOpen = $state(false);
  let syncMode = $state<'offer' | 'join'>('offer');
  let syncJoinPayload = $state('');
  let syncQrPayloadText = $state('');
  let syncQrDataUrl = $state('');
  let syncStatusText = $state('');
  let isSyncSessionBusy = $state(false);

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

    // Remove peer from the known-devices cache so Welcome messages are re-sent.
    try {
      const cacheKey = `known_own_devices:${ctx.userId}`;
      const known: string[] = JSON.parse(localStorage.getItem(cacheKey) ?? '[]');
      localStorage.setItem(cacheKey, JSON.stringify(known.filter((id) => id !== peerDeviceId)));
    } catch {
      /* ignore */
    }

    await ctx.syncOwnDevicesToGroupsLocally();

    ctx.log(
      `[SYNC] Terminée. Envoyés: ${result.uploadedMessageCount}, importés: ${result.importedMessageCount}.`
    );
  }

  async function handleStartSyncSession(ctx: SyncSessionContext) {
    try {
      isSyncSessionBusy = true;
      isSyncSessionOpen = true;
      syncMode = 'offer';
      syncStatusText = 'Initialisation de la session QR...';

      const offerPublicKey = generateEphemeralPublicKey();
      const session = await startSyncSession(ctx.historyBaseUrl, {
        userId: ctx.userId,
        deviceId: ctx.myDeviceId,
        offerPublicKey,
      });

      syncQrPayloadText = encodeSyncQrPayload(session.qrPayload);
      syncQrDataUrl = await createSyncQrDataUrl(syncQrPayloadText);
      syncStatusText = 'Session créée. En attente de jonction du second appareil...';

      const waitUntil = Date.now() + 180_000;
      while (Date.now() < waitUntil) {
        const state = await getSyncSessionState(ctx.historyBaseUrl, {
          sessionId: session.sessionId,
          userId: ctx.userId,
        });
        if (state.state === 'joined' && state.answerDeviceId) {
          syncStatusText = 'Appareil rejoint. Synchronisation bidirectionnelle en cours...';
          await runSyncRound(session.sessionId, state.answerDeviceId, ctx);
          syncStatusText = 'Synchronisation terminée.';
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
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

  function openJoinSyncModal() {
    syncMode = 'join';
    syncJoinPayload = '';
    syncQrPayloadText = '';
    syncQrDataUrl = '';
    syncStatusText = '';
    isSyncSessionOpen = true;
  }

  async function handleConfirmJoinSync(ctx: SyncSessionContext) {
    try {
      isSyncSessionBusy = true;
      syncStatusText = 'Lecture du payload QR...';

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

      syncStatusText = 'Session rejointe. Synchronisation bidirectionnelle en cours...';
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

  function closeModal() {
    if (!isSyncSessionBusy) isSyncSessionOpen = false;
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
