<script lang="ts">
  import type { MembershipTier } from '$lib/associations/api';
  import Input from '$lib/components/ui/Input.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import CotisationTierPicker from './CotisationTierPicker.svelte';
  import type { FormCotisationSettings } from '$lib/forms/cotisationSettings';
  import { m } from '$lib/paraglide/messages';

  /**
   * "Cotisants pay less": the member-price block of the Payment section.
   *
   * Shared verbatim by the create and the edit screen, which each carried their own copy - and had
   * drifted, one gating the member price input on a tag being set and the other not gating it at
   * all.
   *
   * When the association sells more than one tier the restriction picker appears; with a single
   * tier there is nothing to choose between, so it stays hidden and every cotisant qualifies.
   */
  interface Props {
    /** The form's cotisation settings, mutated in place. */
    settings: FormCotisationSettings;
    /** The beneficiary association's tiers; empty when it has no cotisation. */
    tiers: MembershipTier[];
    /** False when there is no association or no tier to price against. */
    available: boolean;
  }

  let { settings = $bindable(), tiers, available }: Props = $props();
</script>

{#if available}
  <div class="border-cn-border space-y-4 border-t-2 pt-4">
    <Toggle
      bind:checked={settings.memberPriceEnabled}
      label={m.form_member_price_toggle_label()}
      hint={m.form_member_price_toggle_hint()}
    />

    {#if settings.memberPriceEnabled}
      {#if tiers.length > 1}
        <CotisationTierPicker
          {tiers}
          value={settings.memberPriceVariantKey}
          label={m.form_member_price_tier_label()}
          hint={m.form_member_price_tier_hint()}
          anyTierLabel={m.form_member_price_tier_any()}
          onValueChange={(key) => (settings.memberPriceVariantKey = key)}
        />
      {/if}
      <Input
        label={m.form_member_price_label()}
        type="number"
        bind:value={settings.basePriceMember}
        min="0"
        step="0.01"
        placeholder={m.form_member_price_placeholder()}
      />
      <p class="text-text-muted ml-1 text-xs">{m.form_member_price_hint()}</p>
    {/if}
  </div>
{/if}
