<script lang="ts">
  import CheckboxGroup from '$lib/components/ui/CheckboxGroup.svelte';
  import { CONTROL_HINT_CLASS } from '$lib/components/ui/controlClasses';
  import type { MembershipTier } from '$lib/associations/api';
  import type { AudienceCondition } from '$lib/forms/api';
  import PromoPicker from '$lib/components/pricing/PromoPicker.svelte';
  import type { FormationOption } from '$lib/pricing/criteriaOptions';
  import { m } from '$lib/paraglide/messages';

  /**
   * One set of criteria, ANDed together - used for who may answer a form, and for whether a question
   * is shown at all.
   *
   * Plain checkboxes rather than the grid's groups, because here there is nothing to partition: a
   * condition is either met or it is not, and nobody needs a price. It reads the SAME criteria the
   * grid does and the server judges both with one predicate, which is the point - a form reserved to
   * the ICM and a price for the ICM must agree about who an ICM is.
   *
   * A criterion left empty is DROPPED rather than stored empty, so a condition never contains a term
   * that matches nobody.
   */
  interface Props {
    /** Null when there is no condition at all; `{}` while one is being built. */
    condition: AudienceCondition | null;
    /** Cotisation tiers of the beneficiary association; empty hides that criterion. */
    tiers: MembershipTier[];
    /** Formation values in use, with counts. */
    formations: FormationOption[];
  }

  let { condition = $bindable(), tiers, formations }: Props = $props();

  /** `null` is the base tier, which has no key - carried through the checkbox list as ''. */
  const TIER_BASE = '';

  /** Reassignment is what Svelte tracks, so every nested edit comes back through here. */
  function update(patch: Partial<AudienceCondition>) {
    condition = { ...condition, ...patch };
  }

  function drop(key: keyof AudienceCondition) {
    const next = { ...condition };
    delete next[key];
    condition = next;
  }

  const isEmpty = $derived(Object.keys(condition ?? {}).length === 0);

  const tierSelection = $derived.by(() => {
    const c = condition?.cotisation;
    if (!c) return [];
    if (c.anyTier) return ['*'];
    return (c.variantKeys ?? []).map((k) => k ?? TIER_BASE);
  });
</script>

<div class="space-y-4">
  <p class={CONTROL_HINT_CLASS}>{m.form_audience_hint()}</p>

  {#if tiers.length > 0}
    <CheckboxGroup
      label={m.form_condition_cotisation_label()}
      options={[
        { value: '*', label: m.form_criterion_any_tier() },
        ...tiers.map((t) => ({ value: t.variantKey ?? TIER_BASE, label: t.name })),
      ]}
      bind:selected={
        () => tierSelection,
        (next) => {
          if (next.length === 0) return drop('cotisation');
          // "Any tier" swallows the specific ones, so it is never stored beside them.
          if (next.includes('*') && !tierSelection.includes('*')) {
            return update({ cotisation: { anyTier: true } });
          }
          const keys = next.filter((k) => k !== '*');
          if (keys.length === 0) return drop('cotisation');
          update({ cotisation: { variantKeys: keys.map((k) => (k === TIER_BASE ? null : k)) } });
        }
      }
    />
  {/if}

  <PromoPicker
    label={m.form_condition_promo_label()}
    selected={condition?.promo?.values ?? []}
    onChange={(next) => (next.length === 0 ? drop('promo') : update({ promo: { values: next } }))}
  />

  <CheckboxGroup
    label={m.form_condition_formation_label()}
    options={formations.map((f) => ({
      value: f.value,
      label: f.value,
      hint: m.form_criterion_formation_count({ count: f.count }),
    }))}
    emptyLabel={m.form_criterion_no_formations()}
    bind:selected={
      () => condition?.formation?.values ?? [],
      (next) => {
        if (next.length === 0) return drop('formation');
        update({ formation: { values: next } });
      }
    }
  />

  {#if isEmpty}
    <p class="text-xs font-semibold text-amber-900 dark:text-amber-100">
      {m.form_condition_empty()}
    </p>
  {/if}
</div>
