<script lang="ts">
  /**
   * ONE FOLLOW SUGGESTION (engagement WP-6, decision 3): the photo, the name, for a person "N en
   * commun" with the faces of accounts the reader already follows (decision 4 - Instagram's
   * "followed by"), the shared "Suivre" chip, and an X that dismisses it for good.
   *
   * NO REASON LINE (L11): no "Promo 2027", no "Membre du BDE" - the count and the faces are all a
   * card discloses. The faces are ones the server already filtered (accepted both ways, no block).
   */
  import { resolve } from '$app/paths';
  import { X } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import FollowChip from '$lib/components/follows/FollowChip.svelte';
  import { peekUserDisplayName, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';
  import type { SuggestionCard } from '$lib/follows/suggestions.svelte';

  interface Props {
    card: SuggestionCard;
    onDismiss: (card: SuggestionCard) => void;
  }

  let { card, onDismiss }: Props = $props();

  let personName = $state<string | null>(null);

  $effect(() => {
    if (card.kind !== 'user') return;
    const id = card.id;
    personName = peekUserDisplayName(id);
    if (personName) return;
    let cancelled = false;
    resolveUserDisplayName(id)
      .then((resolved) => {
        if (!cancelled) personName = resolved;
      })
      .catch((e: unknown) => Log.d('SuggestionCard', `name of ${id.slice(0, 8)}: ${String(e)}`));
    return () => {
      cancelled = true;
    };
  });

  const name = $derived(
    card.kind === 'user' ? (personName ?? m.notif_actor_unknown()) : card.entity.name
  );
</script>

<li
  class="border-cn-border bg-cn-surface relative flex w-40 shrink-0 snap-start flex-col items-center gap-2 rounded-xl border px-3 pt-4 pb-3 text-center"
  data-suggestion-card={card.kind}
  data-suggestion-id={card.id}
>
  <!-- The X: the shared ui/Button (docs/wiki/frontend/controls.md), an icon square in the corner. -->
  <Button
    variant="ghost"
    size="compact"
    icon
    class="absolute top-1 right-1"
    aria-label={m.suggestions_dismiss_named({ name })}
    data-suggestion-dismiss
    onclick={() => onDismiss(card)}
  >
    <X size={14} strokeWidth={2.5} aria-hidden="true" />
  </Button>
  {#snippet identity()}
    <span class="h-16 w-16 shrink-0 overflow-hidden rounded-full">
      {#if card.kind === 'user'}
        <Avatar userId={card.id} fill shape="circle" fallbackLabel={personName ?? ''} />
      {:else}
        <AssociationAvatar
          id={card.entity.id}
          name={card.entity.name}
          logoUrl={card.entity.logoUrl}
          fill
          shape="circle"
        />
      {/if}
    </span>
    <span class="text-text-main block w-full truncate text-sm font-semibold">{name}</span>
  {/snippet}
  {#if card.kind === 'user'}
    <a
      href={resolve('/profile/[id]', { id: encodeURIComponent(card.id) })}
      class="flex min-w-0 flex-col items-center gap-2 self-stretch"
    >
      {@render identity()}
    </a>
  {:else if card.entity.type === 'list'}
    <a
      href={resolve('/lists/[slug]/[[section]]', { slug: card.entity.slug })}
      class="flex min-w-0 flex-col items-center gap-2 self-stretch"
    >
      {@render identity()}
    </a>
  {:else}
    <a
      href={resolve('/associations/[slug]/[[section]]', { slug: card.entity.slug })}
      class="flex min-w-0 flex-col items-center gap-2 self-stretch"
    >
      {@render identity()}
    </a>
  {/if}
  {#if card.kind === 'user' && card.person.mutual > 0}
    <span class="flex items-center gap-1" data-suggestion-common={card.person.mutual}>
      {#if card.person.faces.length > 0}
        <span class="flex -space-x-1.5" aria-hidden="true">
          {#each card.person.faces as face (face)}
            <span class="ring-cn-surface h-4 w-4 overflow-hidden rounded-full ring-2">
              <Avatar userId={face} fill shape="circle" />
            </span>
          {/each}
        </span>
      {/if}
      <span class="text-text-muted text-2xs"
        >{m.suggestions_common_count({ count: card.person.mutual })}</span
      >
    </span>
  {/if}
  <div class="mt-auto">
    <FollowChip kind={card.kind} targetId={card.id} {name} />
  </div>
</li>
