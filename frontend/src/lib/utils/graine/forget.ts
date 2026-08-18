import { isGraineReady, requireGraineRuntime, forgetWorkspaceGraineState } from './runtime';
import { forgetWorkspaceRepairState } from './repair';
import { forgetGraineChannelMirror } from './graineMirror';

/**
 * Erases every trace of one community's Graine material from this device.
 *
 * Called from the ONE seam a community leaves local state through, whichever of the four ways it
 * takes: the member left, an admin removed them, an admin deleted it, or the `workspace.deleted`
 * broadcast arrived for somebody else's deletion. All four mean the same thing here - the seeds
 * open salons this device can no longer even list.
 *
 * Three stores, and none of them can stand in for the others: the durable rows are what the app
 * READS, the native mirror is what a background push reads, and the in-memory maps are what this
 * tab answers from until it is reloaded. A purge that left any one of them would be a purge that
 * looks complete.
 *
 * **Degrades rather than throws.** It runs inside a local purge that has already been decided by
 * the server, so failing it would leave the sidebar and the seeds disagreeing - the worse of the
 * two outcomes. Every branch that gives up says so.
 *
 * @param workspaceId Community leaving this device.
 * @returns How many durable sessions were dropped; 0 when there was nothing, or nothing readable.
 */
export async function forgetCommunityGraine(workspaceId: string): Promise<number> {
  if (!workspaceId) return 0;
  if (!isGraineReady()) {
    // Not silent: seeds outliving the community they belong to is exactly what this exists to stop,
    // and "no runtime" is the one state in which nothing here can run.
    console.warn(
      `[GRAINE] community ${workspaceId.slice(0, 8)} purged with no Graine runtime - its seeds stay on this device`
    );
    return 0;
  }

  const { storage, deviceKeyB64 } = requireGraineRuntime('forgetCommunityGraine');

  // Read BEFORE the delete: the session and channel ids are the keys the in-memory maps and the
  // native mirror are indexed by, and after the delete there is nothing left to derive them from.
  let sessionIds: string[] = [];
  let channelIds: string[] = [];
  try {
    const held = await storage.getGraineSessionsForWorkspace(workspaceId, deviceKeyB64);
    sessionIds = held.map((session) => session.sessionId);
    channelIds = [...new Set(held.map((session) => session.channelId))];
  } catch (e) {
    // An unreadable store still gets its rows dropped below - the delete is by workspace id, a
    // clear column, and needs no device key. What is lost is only the list of what to un-cache.
    console.warn(
      `[GRAINE] could not enumerate the seeds of community ${workspaceId.slice(0, 8)} before purging them: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  let dropped = 0;
  try {
    dropped = await storage.deleteGraineSessionsForWorkspace(workspaceId);
  } catch (e) {
    console.warn(
      `[GRAINE] durable purge failed for community ${workspaceId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  forgetWorkspaceGraineState(workspaceId, sessionIds, channelIds);
  forgetWorkspaceRepairState(workspaceId, sessionIds);
  await Promise.all(channelIds.map((channelId) => forgetGraineChannelMirror(channelId)));

  console.info(
    `[GRAINE] community ${workspaceId.slice(0, 8)} forgotten - ${dropped} seed(s), ${channelIds.length} channel(s) unmirrored`
  );
  return dropped;
}
