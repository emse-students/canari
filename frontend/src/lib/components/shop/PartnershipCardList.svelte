<script lang="ts">
  import {
    claimPartnership,
    SocialApiError,
    type PartnershipCard,
    type PartnershipClaimResult,
  } from '$lib/associations/api';
  import { ExternalLink } from '@lucide/svelte';
  import CardTile from '$lib/components/shared/CardTile.svelte';
  import { CARD_GRID } from '$lib/components/layout/cardGrid';
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

  /**
   * WHAT THE SERVER'S REFUSAL SAYS TO A STUDENT, KEYED BY ITS CODE AND NOT BY ITS SENTENCE.
   *
   * This screen used to render `e.message`, which is the server's own English prose - so a
   * student out of codes read "No codes left for this partnership" in the middle of a French
   * page (user, 2026-09-10). The sentence is written for a log and is not translated; the code
   * beside it is what gets translated, here.
   *
   * ANYTHING NOT IN THIS TABLE BECOMES THE GENERIC LINE, and that is the point rather than a
   * gap: printing an unrecognised `message` is exactly how the English escaped, so there is no
   * path left that can put server prose on screen. A new code shows up as the generic line until
   * somebody adds a translation, which is a missing word - not a leak.
   */
  const CLAIM_ERROR_MESSAGES: Record<string, () => string> = {
    PARTNERSHIP_NO_CODES_LEFT: m.shop_partnership_error_no_codes_left,
    PARTNERSHIP_MEMBERS_ONLY: m.shop_partnership_error_members_only,
    PARTNERSHIP_NOT_FOUND: m.shop_partnership_error_not_found,
    ASSOCIATION_NOT_FOUND: m.shop_partnership_error_not_found,
  };

  function claimErrorText(e: unknown): string {
    const code = e instanceof SocialApiError ? e.code : null;
    const known = code === null ? undefined : CLAIM_ERROR_MESSAGES[code];
    return (known ?? m.shop_partnership_error_generic)();
  }

  async function handleClaim(card: PartnershipCard) {
    claiming = card.id;
    claimErrors = { ...claimErrors, [card.id]: '' };
    try {
      claimResults = {
        ...claimResults,
        [card.id]: await claimPartnership(card.associationId, card.id),
      };
    } catch (e) {
      claimErrors = { ...claimErrors, [card.id]: claimErrorText(e) };
    } finally {
      claiming = null;
    }
  }
</script>

{#if cards.length === 0}
  <p class="text-text-muted py-6 text-center text-sm">{m.shop_partnership_none()}</p>
{:else}
  <div class={CARD_GRID}>
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
                  class="bg-amber-warn/15 text-amber-warn text-2xs rounded-full px-2 py-0.5 font-bold uppercase"
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
