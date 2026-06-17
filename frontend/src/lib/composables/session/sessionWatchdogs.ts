/**
 * Watchdogs de session extraits de useChatSession :
 * startHealthCheck (migration successeurs), startSyncWatchdog (reboot groupes bloqués).
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { checkGroupSuccessors, requestReAdd, RECOVERY_TIMEOUT_MS } from '$lib/utils/chat/recovery';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import { getIsTabLeader } from '$lib/utils/chat/connection';
import type { SessionContext, ChatSessionCallbacks } from './sessionTypes';
import { makeRecoveryDeps } from './sessionAuth';

/**
 * Démarre le health check périodique (toutes les 5 min) qui migre les groupes
 * dont le successeur a été revendiqué par un autre appareil.
 * Lance aussi un check immédiat au démarrage. Écrase tout timer précédent.
 */
export function startHealthCheckImpl(ctx: SessionContext, cb: ChatSessionCallbacks): void {
  const recoveryDeps = makeRecoveryDeps(ctx, cb);

  checkGroupSuccessors(recoveryDeps).catch((e) =>
    cb.log(`[HEALTH] Erreur health check initial: ${e instanceof Error ? e.message : String(e)}`)
  );

  if (ctx.timers.health !== null) clearInterval(ctx.timers.health);
  ctx.timers.health = setInterval(
    () => {
      if (!getIsTabLeader()) return;
      checkGroupSuccessors(recoveryDeps).catch((e) =>
        cb.log(`[HEALTH] Erreur health check: ${e instanceof Error ? e.message : String(e)}`)
      );
    },
    5 * 60 * 1_000
  );
}

/**
 * Démarre le watchdog universel (toutes les 5s) qui relance la recovery de tout groupe
 * non-prêt (sans état WASM local) depuis plus de RECOVERY_TIMEOUT_MS.
 * Couvre tous les chemins de désync, qu'ils aient armé un timer individuel ou non.
 *
 * Passe par `requestReAdd` (welcome_request d'abord, escalade vers reboot via le timer
 * partagé `connectionRecoveryTimers`) plutôt que d'appeler `reboot()` directement : un groupe
 * orphelin se voit ainsi accorder la fenêtre de grâce Welcome avant le CAS irréversible, et
 * `requestReAdd` résout au passage la lignée (migration vers le terminal déjà présent en WASM).
 * Écrase tout timer précédent.
 */
export function startSyncWatchdogImpl(ctx: SessionContext, cb: ChatSessionCallbacks): void {
  /** Timestamp (ms) du moment où chaque groupe a été détecté non-prêt. */
  const notReadySince = new SvelteMap<string, number>();

  if (ctx.timers.syncWatchdog !== null) clearInterval(ctx.timers.syncWatchdog);
  ctx.timers.syncWatchdog = setInterval(() => {
    if (!getIsTabLeader()) return;
    const now = Date.now();
    const recoveryDeps = makeRecoveryDeps(ctx, cb);
    const localGroups = new SvelteSet(recoveryDeps.mlsService.getLocalGroups());

    for (const [id] of cb.conversations) {
      // WASM a l'état → groupe opérationnel (ou Welcome en transit) → pas de recovery.
      // On ne teste PAS convo.isReady : si isReady=true mais WASM a perdu l'état
      // pendant la session, le watchdog doit quand même déclencher la recovery.
      if (localGroups.has(id)) {
        notReadySince.delete(id);
        continue;
      }
      // Channels utilisent AES-GCM, pas MLS - jamais en recovery MLS.
      if (isChannelConversationId(id)) {
        notReadySince.delete(id);
        continue;
      }
      const since = notReadySince.get(id);
      if (since === undefined) {
        notReadySince.set(id, now);
      } else if (now - since > RECOVERY_TIMEOUT_MS) {
        // Re-arme la fenêtre 60s plutôt qu'un flag permanent : si la recovery échoue
        // silencieusement (ex. gagnant du verrou cross-device qui crashe en plein reboot),
        // ce groupe sera re-tenté au prochain cycle de 60s au lieu de rester bloqué. Les
        // reboots concurrents sont déjà empêchés en amont (rebootsInFlight intra-device +
        // verrou Redis cross-device dans reboot()), et requestReAdd déduplique son propre
        // timer - re-déclencher ne provoque qu'un welcome_request toutes les 60s, pas un spam.
        notReadySince.set(id, now);
        cb.log(
          `[SYNC_WATCHDOG] Groupe ${id.slice(0, 8)}… non-prêt depuis >${RECOVERY_TIMEOUT_MS / 1000}s - welcome_request + escalade reboot`
        );
        requestReAdd(id, recoveryDeps, ctx.connectionRecoveryTimers).catch((e: unknown) =>
          cb.log(`[SYNC_WATCHDOG] requestReAdd échoué pour ${id}: ${String(e)}`)
        );
      }
    }
  }, 5_000);
}
