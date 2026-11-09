<script lang="ts">
  /**
   * WHO IS BROADCASTING: the picture and the name a live goes out under - the association's logo
   * and name for a live AS an association, the member's avatar and name otherwise. One component
   * for the feed's LIVE card and the viewer's top bar, so the two never name a live differently.
   *
   * A live row carries ids only (`GET /api/lives`), so the name is resolved here: the member's from
   * the display-name cache (one batched profile fetch), the association's from its record. The
   * resolved name is handed back through `onName` for the caller's accessible label.
   */
  import { untrack } from 'svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import { getAssociation } from '$lib/associations/api';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import type { LiveListItem } from '$lib/live/types';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    live: Pick<LiveListItem, 'broadcasterId' | 'associationId'>;
    /** Told the resolved name, for the caller's accessible label. */
    onName?: (name: string) => void;
    size?: 'sm' | 'md';
  }

  let { live, onName, size = 'md' }: Props = $props();

  let name = $state('');
  $effect(() => {
    onName?.(name);
  });

  let logoUrl = $state<string | null>(null);

  // Keyed on the two ids (strings), never on the row object: a list refresh hands a new object for
  // the same live, and must not re-ask for its name.
  const broadcasterId = $derived(live.broadcasterId);
  const associationId = $derived(live.associationId);

  $effect(() => {
    const asso = associationId;
    const user = broadcasterId;
    let current = true;
    logoUrl = null;
    if (asso) {
      name = m.live_association_unknown();
      getAssociation(asso).then(
        (a) => {
          if (!current) return;
          name = a.name;
          logoUrl = a.logoUrl;
        },
        (e: unknown) => {
          console.warn(`[LIVE] association ${asso} of a live could not be read (${String(e)})`);
        }
      );
    } else {
      // Untracked: the cache is reactive, and this effect writes into it through the resolve below.
      name = untrack(() => getUserDisplayNameSync(user));
      void resolveUserDisplayName(user).then((resolved) => {
        if (current && resolved) name = resolved;
      });
    }
    return () => {
      current = false;
    };
  });
</script>

<span class="flex min-w-0 items-center gap-2" data-live-broadcaster>
  <span class="shrink-0" aria-hidden="true">
    {#if associationId}
      <AssociationAvatar
        id={live.associationId ?? live.broadcasterId}
        {name}
        {logoUrl}
        {size}
        shape="circle"
      />
    {:else}
      <Avatar userId={broadcasterId} {size} />
    {/if}
  </span>
  <span class="min-w-0 truncate font-semibold">{name}</span>
</span>
