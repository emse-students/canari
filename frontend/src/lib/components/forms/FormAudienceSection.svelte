<script lang="ts">
  import { UserCheck } from '@lucide/svelte';
  import FormSection from './FormSection.svelte';
  import AudienceConditionEditor from './AudienceConditionEditor.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import type { MembershipTier } from '$lib/associations/api';
  import type { AudienceCondition } from '$lib/forms/api';
  import type { FormationOption } from '$lib/forms/criteriaOptions';
  import { m } from '$lib/paraglide/messages';

  /**
   * Who may answer the form at all: off by default, and one switch away from a full set of criteria.
   *
   * It sits before the money section on purpose - who may answer is read first, what they pay
   * second. The criteria are the SAME ones the pricing grid divides on, judged by the same server
   * predicate, so a form reserved to one promo and a price for that promo cannot disagree.
   */
  interface Props {
    /** Null when anybody may answer. */
    submitCondition: AudienceCondition | null;
    tiers: MembershipTier[];
    formations: FormationOption[];
  }

  let { submitCondition = $bindable(), tiers, formations }: Props = $props();
</script>

<FormSection title={m.form_audience_section()} icon={UserCheck}>
  <Toggle
    label={m.form_audience_toggle()}
    hint={m.form_audience_toggle_hint()}
    bind:checked={
      () => submitCondition != null,
      (on) => {
        submitCondition = on ? {} : null;
      }
    }
  />
  {#if submitCondition != null}
    <AudienceConditionEditor bind:condition={submitCondition} {tiers} {formations} />
  {/if}
</FormSection>
