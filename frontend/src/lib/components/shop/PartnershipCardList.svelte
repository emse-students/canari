<script lang="ts">
  import {
    claimPartnership,
    type PartnershipCard,
    type PartnershipClaimResult,
  } from '$lib/associations/api';
  import { ExternalLink } from '@lucide/svelte';
  import CardTile from '$lib/components/shared/CardTile.svelte';
  import { PARTNERSHIP_FALLBACK_ICON } from '$lib/utils/cardIcons';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    cards: PartnershipCard[];
  }

  let { cards }: Props = $props();

  let claimResults = $state<Record<string, PartnershipClaimResult>>({});
  let claimErrors = $state<Record<string, string>>({});
  let claiming = $state<string | null>(null);

  async function handleClaim(card: PartnershipCard) {
    claiming = card.id;
    claimErrors = { ...claimErrors, [card.id]: '' };
    try {
      claimResults = {
        ...claimResults,
        [card.id]: await claimPartnership(card.associationId, card.id),
      };
    } catch (e) {
      claimErrors = { ...claimErrors, [card.id]: e instanceof Error ? e.message : 'Error' };
    } finally {
      claiming = null;
    }
  }
</script>

{#if cards.length === 0}
  <p class="text-text-muted py-6 text-center text-sm">{m.shop_partnership_none()}</p>
{:else}
  <div class="grid gap-4 sm:grid-cols-2">
    {#each cards as card (card.id)}
      {@const locked = card.membersOnly && !card.viewerIsCotisant}
      {@const result = claimResults[card.id]}
      <CardTile iconUrl={card.iconUrl} fallbackIcon={PARTNERSHIP_FALLBACK_ICON}>
        <div class="flex h-full flex-col gap-3 p-5">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <p class="text-text-main text-sm font-semibold">
                {card.title}
              </p>
              {#if card.membersOnly}
                <span
                  class="bg-amber-warn/15 text-amber-warn rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
                >
                  {m.shop_partnership_members_only_badge()}
                </span>
              {/if}
            </div>
            {#if card.description}
              <p class="text-text-muted mt-0.5 text-xs">{card.description}</p>
            {/if}
            {#if card.link}
              <a
                href={card.link}
                target="_blank"
                rel="noopener noreferrer"
                class="text-cn-dark mt-1 inline-flex items-center gap-1 text-xs font-semibold hover:underline"
              >
                {m.shop_partnership_visit_link()}
                <ExternalLink size={12} />
              </a>
            {/if}
          </div>

          {#if locked}
            <p class="text-text-muted text-xs">{m.shop_partnership_members_only_hint()}</p>
          {:else if result}
            <div class="bg-cn-accent/10 border-cn-accent/30 rounded-lg border px-3 py-2">
              {#if result.mode === 'text'}
                <p class="text-text-main text-sm">{result.staticText}</p>
              {:else}
                <p class="text-text-muted text-xs">{m.shop_partnership_your_code_label()}</p>
                <p class="text-text-main font-mono text-sm font-bold">{result.code}</p>
              {/if}
            </div>
          {:else}
            {#if claimErrors[card.id]}
              <p class="text-red-err text-xs">{claimErrors[card.id]}</p>
            {/if}
            <button
              type="button"
              onclick={() => handleClaim(card)}
              disabled={claiming === card.id}
              class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover w-full rounded-lg px-3 py-1.5 text-xs font-bold transition-colors disabled:opacity-50"
            >
              {claiming === card.id
                ? m.shop_partnership_claiming()
                : m.shop_partnership_claim_button()}
            </button>
          {/if}
        </div>
      </CardTile>
    {/each}
  </div>
{/if}
