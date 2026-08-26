<script lang="ts">
  import type { MembershipTier } from '$lib/associations/api';
  import type { AudienceCondition } from '$lib/forms/api';
  import type { FormationOption } from '$lib/forms/criteriaOptions';
  import type {
    CotisationGrantBlocker,
    FormCotisationSettings,
  } from '$lib/forms/cotisationSettings';
  import Input from '$lib/components/ui/Input.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import {
    CONTROL_HINT_CLASS,
    CONTROL_LABEL_CLASS,
    controlClass,
  } from '$lib/components/ui/controlClasses';
  import AudienceConditionEditor from './AudienceConditionEditor.svelte';
  import CotisationTierPicker from './CotisationTierPicker.svelte';
  import FormSection from './FormSection.svelte';
  import { Settings2 } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * "Parametres avances": everything real but rarely wanted, folded away so the common case - a
   * title, a price, some questions - is not buried under it.
   *
   * It holds three groups now rather than one setting. They were four top-level cards, and a
   * manager writing a plain free form scrolled past every one of them: a response cap, a repeat
   * switch, an opening date, an audience condition and a cotisation grant are each wanted by a
   * handful of forms a year. Grouped and collapsed, they cost nobody a scroll and are still one
   * click away.
   *
   * The header BADGE is what keeps that honest: a folded section holding a live restriction is a
   * setting nobody can see, so the badge says so from outside. An audience restriction wins the
   * badge over the count, because it is the one that decides whether a person may answer at all.
   */
  interface Props {
    /** Cap on accepted responses; undefined for no cap. */
    maxSubmissions: number | undefined;
    /** Whether one person may answer more than once. */
    allowMultipleSubmissions: boolean;
    /** Opening date, as a `datetime-local` string. Empty when the form is open at once. */
    opensAt: string;
    /** Who may answer at all; null means anybody. */
    submitCondition: AudienceCondition | null;
    /** The form's cotisation settings, mutated in place. */
    settings: FormCotisationSettings;
    /** The beneficiary association's tiers; empty when it has no cotisation. */
    tiers: MembershipTier[];
    /** Formation values in use, for the formation criterion. */
    formations: FormationOption[];
    /** Why the cotisation grant cannot be offered; null when it can. */
    grantBlocker: CotisationGrantBlocker | null;
    /** The beneficiary association's name, for the explanation of what gets granted. */
    associationName: string;
  }

  let {
    maxSubmissions = $bindable(),
    allowMultipleSubmissions = $bindable(),
    opensAt = $bindable(),
    submitCondition = $bindable(),
    settings = $bindable(),
    tiers,
    formations,
    grantBlocker,
    associationName,
  }: Props = $props();

  /** Settings that are actually doing something, so the folded header can say how many. */
  const activeCount = $derived(
    (maxSubmissions != null && maxSubmissions > 0 ? 1 : 0) +
      (allowMultipleSubmissions ? 1 : 0) +
      (opensAt ? 1 : 0) +
      (settings.grantsCotisation ? 1 : 0)
  );

  const badge = $derived.by(() => {
    if (submitCondition != null) return m.form_advanced_badge_restricted();
    if (activeCount === 1) return m.form_advanced_badge_active_one();
    if (activeCount > 1) return m.form_advanced_badge_active({ count: activeCount });
    return undefined;
  });
</script>

<FormSection
  title={m.form_section_advanced()}
  icon={Settings2}
  {badge}
  collapsible
  startOpen={false}
>
  <div class="space-y-4">
    <p class="text-text-main text-sm font-bold">{m.form_section_responses()}</p>

    <Input
      label={m.form_max_responses_label()}
      type="number"
      bind:value={maxSubmissions}
      placeholder={m.form_max_responses_placeholder()}
      min="1"
    />

    <Toggle
      bind:checked={allowMultipleSubmissions}
      label={m.form_allow_multiple_label()}
      hint={m.form_allow_multiple_hint()}
    />

    <div>
      <label for="form-opens-at" class={CONTROL_LABEL_CLASS}>{m.form_opens_at_label()}</label>
      <input id="form-opens-at" type="datetime-local" bind:value={opensAt} class={controlClass()} />
      <p class={CONTROL_HINT_CLASS}>{m.form_opens_at_hint()}</p>
    </div>
  </div>

  <div class="border-cn-border space-y-4 border-t-2 pt-4">
    <p class="text-text-main text-sm font-bold">{m.form_audience_section()}</p>

    <!-- The criteria here are the SAME ones the pricing grid divides on, judged by the same server
         predicate, so a form reserved to one promo and a price for that promo cannot disagree. -->
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
  </div>

  <div class="border-cn-border space-y-4 border-t-2 pt-4">
    <p class="text-text-main text-sm font-bold">{m.form_advanced_group_cotisation()}</p>

    {#if grantBlocker}
      <!-- The cause, named. Which of the four conditions is missing decides what the manager does
           next, and three of the four are fixable from this very screen. -->
      <p class="text-text-muted text-sm">
        {grantBlocker === 'no-payment'
          ? m.form_grant_blocked_no_payment()
          : grantBlocker === 'no-association'
            ? m.form_grant_blocked_no_association()
            : grantBlocker === 'no-cotisation'
              ? m.form_grant_blocked_no_cotisation({ association: associationName })
              : m.form_grant_blocked_no_right({ association: associationName })}
      </p>
    {:else}
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
    {/if}
  </div>
</FormSection>
