/**
 * Watchdogs de session extraits de useChatSession :
 * startHealthCheck (migration successeurs), startSyncWatchdog (reboot groupes bloqués).
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { checkGroupSuccessors, reboot, RECOVERY_TIMEOUT_MS } from '$lib/utils/chat/recovery';
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
 * Démarre le watchdog universel (toutes les 5s) qui reboot tout groupe non-prêt
 * (sans état WASM local) depuis plus de RECOVERY_TIMEOUT_MS.
 * Couvre tous les chemins de désync, qu'ils aient armé un timer individuel ou non.
 * Écrase tout timer précédent.
 */
export function startSyncWatchdogImpl(ctx: SessionContext, cb: ChatSessionCallbacks): void {
  /** Timestamp (ms) du moment où chaque groupe a été détecté non-prêt. */
  const notReadySince = new SvelteMap<string, number>();
  /**
   * Guard in-flight : évite de lancer plusieurs reboots concurrents pour le même groupe.
   * Sans ce guard, un reboot lent (>30s réseau) serait relancé à chaque expiration du
   * compteur notReadySince. Le CAS gère la race, mais crée des candidats orphelins.
   */
  const rebootingGroups = new SvelteSet<string>();

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
        rebootingGroups.delete(id); // Welcome arrivé pendant un reboot → nettoyer
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
      } else if (now - since > RECOVERY_TIMEOUT_MS && !rebootingGroups.has(id)) {
        notReadySince.delete(id);
        rebootingGroups.add(id);
        cb.log(`[SYNC_WATCHDOG] Groupe ${id.slice(0, 8)}… non-prêt depuis >30s - reboot`);
        reboot(id, recoveryDeps)
          .catch((e: unknown) => cb.log(`[SYNC_WATCHDOG] reboot échoué pour ${id}: ${String(e)}`))
          .finally(() => rebootingGroups.delete(id));
      }
    }
  }, 5_000);
}
