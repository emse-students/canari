<script lang="ts">
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import type { SkyEntourageMember } from '$lib/profile/api';
  import { Users } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    parrains: SkyEntourageMember[];
    fillots: SkyEntourageMember[];
    loading?: boolean;
  }

  const props: Props = $props();
  const parrains = $derived(props.parrains ?? []);
  const fillots = $derived(props.fillots ?? []);
  const loading = $derived(props.loading ?? false);

  function fullName(member: SkyEntourageMember): string {
    return `${member.prenom} ${member.nom}`.trim();
  }
</script>

{#snippet group(label: string, members: SkyEntourageMember[])}
  {#if members.length > 0}
    <div class="space-y-2">
      <p class="text-xs font-bold uppercase tracking-wider text-text-muted">{label}</p>
      <ul class="space-y-2">
        {#each members as member (member.sub ?? fullName(member))}
          {@const inner = fullName(member)}
          <li>
            <svelte:element
              this={member.sub ? 'a' : 'div'}
              href={member.sub ? `/profile/${encodeURIComponent(member.sub)}` : undefined}
              class="flex items-center gap-3 rounded-xl border border-cn-border bg-white/50 dark:bg-white/5 px-4 py-3 {member.sub
                ? 'hover:border-cn-yellow/30 transition-colors'
                : ''}"
            >
              <Avatar userId={member.sub ?? ''} size="sm" fallbackLabel={inner} />
              <div class="min-w-0 flex-1">
                <p class="text-sm font-bold text-text-main truncate">{inner}</p>
                <p class="text-xs text-text-muted mt-0.5">
                  {member.level ? `Promo ${member.level}` : ''}{#if member.kind === 'adoption'}
                    · {m.profile_public_sponsorship_adoption()}{/if}
                </p>
              </div>
            </svelte:element>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
{/snippet}

<div class="space-y-5">
  {#if loading}
    <p class="text-sm text-text-muted">{m.common_loading_label()}</p>
  {:else if parrains.length === 0 && fillots.length === 0}
    <p class="text-sm text-text-muted flex items-center gap-2">
      <Users size={16} />
      {m.profile_public_sponsorship_empty()}
    </p>
  {:else}
    {@render group(m.profile_public_sponsors_label(), parrains)}
    {@render group(m.profile_public_godchildren_label(), fillots)}
  {/if}
</div>
