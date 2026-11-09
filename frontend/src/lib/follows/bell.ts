/**
 * THE BELL ON AN ACCOUNT (engagement WP-3, docs/wiki/engagement.md): what the reader receives from
 * one person or one entity - posts and lives (the default, which every follow sets), lives only, or
 * nothing. It reduces the PUSH only: the posts stay in the feed and in the notifications list. The
 * followed account never learns it.
 *
 * On social-service under `/api/posts/me/bells/...`, the caller's own row. It replaced the
 * association's push mute (`/api/associations/:id/push-mute`, kept server-side for older builds).
 */
import { socialRequest } from '$lib/posts/api';
import { Log } from '$lib/utils/Log';
import { m } from '$lib/paraglide/messages';
import type { PickerOption } from '$lib/components/ui/picker';

/** `all` = posts and lives, the default; `lives` = lives only; `none` = nothing pushed. */
export type BellLevel = 'all' | 'lives' | 'none';

/** Whose bell: a person, or an entity (an association, a list, an institution). */
export type BellTargetKind = 'user' | 'association';

const path = (kind: BellTargetKind, targetId: string) =>
  `/api/posts/me/bells/${kind}/${encodeURIComponent(targetId)}`;

/** One account the reader reduced. `name` is an association's; a person's is null, named by id. */
export interface ReducedBell {
  kind: BellTargetKind;
  targetId: string;
  level: Exclude<BellLevel, 'all'>;
  name: string | null;
}

/** Every account the reader reduced, for the notification settings. */
export async function listReducedBells(): Promise<ReducedBell[]> {
  return socialRequest<ReducedBell[]>('/api/posts/me/bells');
}

/** The reader's level for one account; `all` when they never reduced it. */
export async function getBellLevel(kind: BellTargetKind, targetId: string): Promise<BellLevel> {
  const { level } = await socialRequest<{ level: BellLevel }>(path(kind, targetId));
  return level;
}

/**
 * Sets the reader's level. Idempotent. Refused (404 `BELL_TARGET_NOT_FOUND`) on a person the reader
 * does not follow - the control is only offered once they do.
 */
export async function setBellLevel(
  kind: BellTargetKind,
  targetId: string,
  level: BellLevel
): Promise<BellLevel> {
  Log.d('bell', `${kind} ${targetId.slice(0, 8)} -> ${level}`);
  const answer = await socialRequest<{ level: BellLevel }>(path(kind, targetId), {
    method: 'PUT',
    body: JSON.stringify({ level }),
  });
  return answer.level;
}

/** The three choices as the picker draws them, in the order a reader reduces them. */
export function bellOptions(): PickerOption[] {
  return [
    { value: 'all', label: m.bell_level_all(), description: m.bell_level_all_hint() },
    { value: 'lives', label: m.bell_level_lives(), description: m.bell_level_lives_hint() },
    { value: 'none', label: m.bell_level_none(), description: m.bell_level_none_hint() },
  ];
}
