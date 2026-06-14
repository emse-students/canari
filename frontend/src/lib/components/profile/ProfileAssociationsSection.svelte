<script lang="ts">
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import type { UserMembershipRow } from '$lib/profile/api';
  import { Building2 } from '@lucide/svelte';

  interface Props {
    memberships: UserMembershipRow[];
    loading?: boolean;
    emptyMessage?: string;
  }

  const props: Props = $props();
  const memberships = $derived(props.memberships);
  const loading = $derived(props.loading ?? false);
  const emptyMessage = $derived(props.emptyMessage ?? 'Aucune association pour le moment.');
</script>

<div class="space-y-3">
  {#if loading}
    <p class="text-sm text-text-muted">Chargement…</p>
  {:else if memberships.length === 0}
    <p class="text-sm text-text-muted">{emptyMessage}</p>
  {:else}
    <ul class="space-y-2">
      {#each memberships as m (m.associationId)}
        <li>
          <a
            href="/associations/{encodeURIComponent(m.slug)}"
            class="flex items-center gap-3 rounded-xl border border-cn-border bg-white/50 dark:bg-white/5 px-4 py-3 hover:border-cn-yellow/30 transition-colors"
          >
            <AssociationAvatar name={m.name} logoUrl={m.logoUrl} size="sm" />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-bold text-text-main truncate">{m.name}</p>
              <p class="text-xs text-text-muted mt-0.5">
                {m.role}{#if m.isAdmin}
                  · Admin{/if}
              </p>
            </div>
            <Building2 size={16} class="shrink-0 text-text-muted" />
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</div>
