<script lang="ts">
  import type { MembershipTier } from '$lib/associations/api';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import FormSection from './FormSection.svelte';
  import CotisationTierPicker from './CotisationTierPicker.svelte';
  import type { FormCotisationSettings } from '$lib/forms/cotisationSettings';
  import { Settings2 } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * "Paramètres avancés": settings that are real but rarely wanted, folded away by default so the
   * common case - a title, a price, some questions - is not buried under them.
   *
   * Today it holds one: granting the association's cotisation when the payment lands. It is the
   * whole reason this section exists, and the reason it is collapsed: a handful of forms a year
   * want it.
   */
  interface Props {
    /** The form's cotisation settings, mutated in place. */
    settings: FormCotisationSettings;
    /** The beneficiary association's tiers; empty when it has no cotisation. */
    tiers: MembershipTier[];
    /** False when there is no payment, no association, or no tier to grant. */
    available: boolean;
    /** The beneficiary association's name, for the explanation of what gets granted. */
    associationName: string;
  }

  let { settings = $bindable(), tiers, available, associationName }: Props = $props();
</script>

<FormSection title={m.form_section_advanced()} icon={Settings2} collapsible startOpen={false}>
  {#if available}
    <Toggle
      bind:checked={settings.grantsCotisation}
      label={m.form_grant_cotisation_label()}
      hint={m.form_grant_cotisation_hint({ association: associationName })}
    />

    {#if settings.grantsCotisation}
      {#if tiers.length > 1}
        <CotisationTierPicker
          {tiers}
          value={settings.cotisationVariantKey}
          label={m.form_grant_cotisation_tier_label()}
          hint={m.form_grant_cotisation_tier_hint()}
          onValueChange={(key) => (settings.cotisationVariantKey = key)}
        />
      {/if}
      <!-- Nothing here asks for an expiry: a cotisation's validity comes from the association's
           own lifetime/yearly setting, and a per-form date could only contradict it. -->
      <p
        class="border-cn-yellow/30 bg-cn-yellow/5 text-text-muted rounded-xl border px-3 py-2.5 text-xs"
      >
        {m.form_grant_cotisation_expiry_note()}
      </p>
    {/if}
  {:else}
    <p class="text-text-muted text-sm">{m.form_grant_cotisation_unavailable()}</p>
  {/if}
</FormSection>
