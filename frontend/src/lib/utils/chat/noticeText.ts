/**
 * THE SENTENCE OF A NOTICE ROW, DRAWN FROM THE IDS IT CARRIES.
 *
 * A "X a rejoint" / "X a ajouté Y" row used to store the sentence with the names baked in at write
 * time. A newcomer's profile is often not resolvable at that instant (a 404 or a name-less row on a
 * just-created account), so the row was written "Utilisateur inconnu a ..." and stayed so for good:
 * a stored string is never redrawn. The row now ALSO carries the ids (`NoticeSpec`), and the
 * renderer draws this sentence from whatever the one display-name source knows at that moment.
 *
 * @see docs/wiki/frontend/chat.md
 */
import { m } from '$lib/paraglide/messages';
import type { NoticeSpec } from '$lib/envelope';

/** Every user id the sentence names, in the order it names them. */
export function noticeUserIds(spec: NoticeSpec): string[] {
  return [spec.actor, ...(spec.targets ?? [])];
}

/** The sentence for `spec`, each person named by `nameOf` (a lookup that never fetches). */
export function noticeText(spec: NoticeSpec, nameOf: (userId: string) => string): string {
  const sender = nameOf(spec.actor);
  const targets = spec.targets ?? [];
  switch (spec.event) {
    case 'memberAdded':
      return m.chat_system_member_added({
        sender,
        members: targets.map((t) => nameOf(t)).join(', '),
      });
    case 'memberRemoved':
      return m.chat_system_member_removed({ sender, target: nameOf(targets[0] ?? '') });
    case 'memberLeft':
      return m.chat_system_member_left({ user: sender });
    case 'uninvitedEntry':
      return m.chat_system_uninvited_entry({ user: sender });
    case 'unvouchedDeviceEntry':
      return m.chat_system_unvouched_device_entry({ user: sender });
    case 'groupRenamed':
      return m.chat_system_group_renamed({ sender, name: spec.name ?? '' });
    case 'groupPhotoChanged':
      return m.chat_system_group_photo_changed({ sender });
    case 'groupPhotoRemoved':
      return m.chat_system_group_photo_removed({ sender });
  }
}

/**
 * The sentence a notice row SHOWS: drawn from the ids when every person it names is known
 * (`knownName` answers without fetching, `null` for a name not known yet), the STORED sentence
 * otherwise. The stored one was drawn by the writer with the names it held, so on a cold cache (a
 * relaunch, offline) it is the best text there is - drawing the ids then would turn a row that named
 * everyone into "Utilisateur inconnu" until each profile is fetched again, and for good when it
 * cannot be (review of #3232).
 */
export function noticeDisplayText(
  spec: NoticeSpec,
  stored: string,
  knownName: (userId: string) => string | null
): string {
  const names = new Map<string, string>();
  for (const id of noticeUserIds(spec)) {
    const name = knownName(id);
    if (name === null) return stored;
    names.set(id, name);
  }
  return noticeText(spec, (id) => names.get(id) ?? '');
}
