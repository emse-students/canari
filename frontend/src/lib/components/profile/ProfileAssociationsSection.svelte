<script lang="ts">
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import type { UserMembershipRow } from '$lib/profile/api';
  import { isPastCampaignList } from '$lib/associations/campaign';
  import { Building2 } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    memberships: UserMembershipRow[];
    loading?: boolean;
    emptyMessage?: string;
  }

  const props: Props = $props();
  // Finished campaign lists (past their 1 August cutoff) drop out of the current
  // memberships; the user can still surface them under their associative history.
  const memberships = $derived(props.memberships.filter((mb) => !isPastCampaignList(mb)));
  const loading = $derived(props.loading ?? false);
  const emptyMessage = $derived(props.emptyMessage ?? m.profile_asso_empty());
</script>

<div class="space-y-3">
  {#if loading}
    <p class="text-text-muted text-sm">{m.common_loading_label()}</p>
  {:else if memberships.length === 0}
    <p class="text-text-muted text-sm">{emptyMessage}</p>
  {:else}
    <ul class="space-y-2">
      {#each memberships as mb (mb.associationId)}
        <li>
          <a
            href="/associations/{encodeURIComponent(mb.slug)}"
            class="border-cn-border hover:border-cn-yellow/30 flex items-center gap-3 rounded-xl border bg-white/50 px-4 py-3 transition-colors dark:bg-white/5"
          >
            <AssociationAvatar name={mb.name} logoUrl={mb.logoUrl} size="sm" />
            <div class="min-w-0 flex-1">
              <p class="text-text-main truncate text-sm font-bold">{mb.name}</p>
              <p class="text-text-muted mt-0.5 text-xs">
                {mb.role}{#if mb.isAdmin}
                  · Admin{/if}
              </p>
            </div>
            <Building2 size={16} class="text-text-muted shrink-0" />
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</div>
