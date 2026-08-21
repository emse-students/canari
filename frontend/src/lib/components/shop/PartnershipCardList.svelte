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
    /** Accent color applied to every card - see `CardTile`'s `accentColor` doc. */
    accentColor?: string | null;
  }

  let { cards, accentColor }: Props = $props();

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
      <CardTile
        iconUrl={card.iconUrl}
        fallbackIcon={PARTNERSHIP_FALLBACK_ICON}
        {accentColor}
        badgeText={card.badgeText}
      >
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

          <!-- Reserves the tallest of button/result/hint so claiming never resizes the card -
               a row's cards would otherwise visibly jump when only one of them grows. -->
          <div class="flex min-h-16 flex-col justify-end">
            {#if locked}
              <p class="text-text-muted text-xs">{m.shop_partnership_members_only_hint()}</p>
            {:else if card.claimMode === 'text'}
              <!-- A static instruction is not a code being handed out - nothing to claim, so
                   nothing to gate behind a button. Already present on the public listing (only
                   sharedCode is stripped there). -->
              <div class="bg-cn-accent/10 border-cn-accent/30 min-w-0 rounded-lg border px-3 py-2">
                <p class="text-text-main text-sm break-words">{card.staticText}</p>
              </div>
            {:else if result}
              <div class="bg-cn-accent/10 border-cn-accent/30 min-w-0 rounded-lg border px-3 py-2">
                <p class="text-text-muted text-xs">{m.shop_partnership_your_code_label()}</p>
                <p class="text-text-main font-mono text-sm font-bold break-all">{result.code}</p>
              </div>
            {:else}
              {#if claimErrors[card.id]}
                <p class="text-red-err mb-1 text-xs">{claimErrors[card.id]}</p>
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
        </div>
      </CardTile>
    {/each}
  </div>
{/if}
