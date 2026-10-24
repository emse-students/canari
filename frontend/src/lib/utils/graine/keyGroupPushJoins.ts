/**
 * THE KEY GROUPS A SHUT PHONE JOINED FROM A PUSH, HANDED TO THE APP AT ITS START
 * (channel-encryption section 26, decided by the user 2026-10-22).
 *
 * Android's push service joins a community's key group when a salon push names one this device
 * holds no seat in, and installs the new tree into `mls.bin` itself. What it cannot write is the
 * app's key-group REGISTRY (the SQLite `distribution_groups` table), so the tree would be held and
 * its frames routed as a conversation's until the community loads - the very gap
 * `hydrateDistributionGroups` closes. The native side keeps a ledger of every attempt
 * (`mobile/key_group_join.rs`); the app takes and clears it once per start, right after the
 * registry is restored and before anything drains.
 *
 * Taking clears the ledger, which is also what hands a refused or lost group back to the app's own
 * join: from this start on, the community loop owns it.
 */

import type { IMlsService } from '$lib/mls-client/IMlsService';
import { channelScope, workspaceScope } from '$lib/mls-client/distributionScope';
import { holdsGroupState } from '$lib/utils/chat/groupUsability';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { workspaceForChannel } from './runtime';

/** One ledger entry, as `take_key_group_push_joins` returns it. */
export interface KeyGroupPushJoin {
  groupId: string;
  /**
   * `joined`, `refused`, `lost`, `deferred` (refused for a base the push will not retry until it
   * changes), or `attempting` (a push service killed mid-attempt, or an install that never ran).
   */
  state: string;
  scopeKind?: string | null;
  scopeId?: string | null;
  reason?: string | null;
}

/** What {@link adoptKeyGroupPushJoins} did with the entries, for the caller's one log line. */
export interface KeyGroupPushJoinAdoption {
  registered: number;
  noted: number;
  ignored: number;
}

/**
 * Registers every key group the push service JOINED, and logs every other entry.
 *
 * Never over an existing mapping: a group the registry already knows keeps the scope the app gave
 * it, whatever the ledger says.
 *
 * A `joined` entry is believed only when the MLS state loaded at this start holds the group - the
 * ledger is a claim, the tree is the fact. A workspace scope is registered with its community; a
 * private salon's scope needs the community behind the channel, which this early in a start is
 * known only if a previous load cached it, so it is otherwise NOTED as a key group, exactly as a
 * Welcome into an unloaded salon's group is, and the community load names it.
 *
 * Split from the invoke so it is tested without a Tauri runtime.
 */
export function adoptKeyGroupPushJoins(
  mlsService: Pick<
    IMlsService,
    'registerDistributionGroup' | 'noteDistributionGroup' | 'isDistributionGroup'
  >,
  entries: KeyGroupPushJoin[],
  log: (line: string) => void,
  holds: (groupId: string) => boolean
): KeyGroupPushJoinAdoption {
  const result: KeyGroupPushJoinAdoption = { registered: 0, noted: 0, ignored: 0 };
  for (const entry of entries) {
    const short = entry.groupId.slice(0, 8);
    if (entry.state !== 'joined') {
      // Not a failure of this start: the community loop joins the group the ordinary way.
      log(
        `[KEY_GROUP_PUSH_JOIN] ${short} ${entry.state} from a push (${entry.reason ?? 'no reason'}) - the community load joins it`
      );
      result.ignored++;
      continue;
    }
    if (!holds(entry.groupId)) {
      // The install was refused after the server accepted, or the state was replaced since: the
      // ledger says joined and the tree says no. The tree wins; the community load repairs it.
      log(
        `[KEY_GROUP_PUSH_JOIN] ${short} joined from a push but NOT in the loaded state - ignored, the community load joins it`
      );
      result.ignored++;
      continue;
    }
    if (mlsService.isDistributionGroup(entry.groupId)) {
      // THE APP'S OWN MAPPING WINS. The registry restored above already names this group (or the
      // server named it to this session); a scope the push service was TOLD is never written over
      // one the app established itself.
      log(
        `[KEY_GROUP_PUSH_JOIN] ${short} joined from a push and already registered - the existing mapping kept`
      );
      result.ignored++;
      continue;
    }
    if (entry.scopeKind === 'workspace' && entry.scopeId) {
      mlsService.registerDistributionGroup(workspaceScope(entry.scopeId), entry.groupId);
      log(`[KEY_GROUP_PUSH_JOIN] ${short} joined from a push - registered for its community`);
      result.registered++;
      continue;
    }
    const workspaceId =
      entry.scopeKind === 'channel' && entry.scopeId ? workspaceForChannel(entry.scopeId) : null;
    if (entry.scopeKind === 'channel' && entry.scopeId && workspaceId) {
      mlsService.registerDistributionGroup(channelScope(workspaceId, entry.scopeId), entry.groupId);
      log(`[KEY_GROUP_PUSH_JOIN] ${short} joined from a push - registered for its salon`);
      result.registered++;
      continue;
    }
    mlsService.noteDistributionGroup(entry.groupId);
    log(
      `[KEY_GROUP_PUSH_JOIN] ${short} joined from a push - noted as a key group, scope ${entry.scopeKind ?? 'unknown'} named at its community load`
    );
    result.noted++;
  }
  return result;
}

/**
 * Takes the native ledger and adopts it. A no-op off the native app; an unreadable ledger is
 * logged and leaves every group to the community loop, which joins it anyway.
 */
export async function takeKeyGroupPushJoins(
  mlsService: IMlsService,
  log: (line: string) => void
): Promise<KeyGroupPushJoinAdoption | null> {
  if (!isTauriRuntime()) return null;
  let entries: KeyGroupPushJoin[];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    entries = await invoke<KeyGroupPushJoin[]>('take_key_group_push_joins');
  } catch (e) {
    console.error('[KEY_GROUP_PUSH_JOIN] the push-join ledger could not be taken:', String(e));
    return null;
  }
  if (entries.length === 0) return { registered: 0, noted: 0, ignored: 0 };
  const result = adoptKeyGroupPushJoins(mlsService, entries, log, (groupId) =>
    holdsGroupState(mlsService, groupId)
  );
  log(
    `[KEY_GROUP_PUSH_JOIN] ${entries.length} ledger entr${entries.length === 1 ? 'y' : 'ies'}: ${result.registered} registered, ${result.noted} noted, ${result.ignored} left to the community load`
  );
  return result;
}
