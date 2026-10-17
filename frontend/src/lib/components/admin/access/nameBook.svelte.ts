/**
 * Display names for the user ids an access list shows - the sync cache at once, then the resolved
 * name when it arrives. One per panel, so both access lists read names the same way.
 */
import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';

/** A reactive id -> display name map; an id not yet resolved reads as itself. */
export function createNameBook() {
  let names = $state<Record<string, string>>({});
  return {
    nameOf(id: string): string {
      return names[id] ?? id;
    },
    resolve(ids: Iterable<string>): void {
      for (const id of ids) {
        // Also dedups: the first sighting writes the entry synchronously.
        if (id in names) continue;
        names = { ...names, [id]: getUserDisplayNameSync(id) || id };
        void resolveUserDisplayName(id).then((name) => {
          if (name) names = { ...names, [id]: name };
        });
      }
    },
  };
}
