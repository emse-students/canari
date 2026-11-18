<script lang="ts">
  import Input from '$lib/components/ui/Input.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import { CONTROL_HINT_CLASS } from '$lib/components/ui/controlClasses';
  import {
    DECLARED_PROMO_MAX,
    DECLARED_PROMO_MIN,
    NO_FORMATION,
    campusOptions,
    declaredProblem,
    formationOptions,
    respondentChoiceLabel,
    statusOptions,
    type DeclaredField,
    type DeclaredValues,
  } from '$lib/forms/respondentFields';
  import { m } from '$lib/paraglide/messages';

  /**
   * "A propos de vous" - the respondent's fields a form asks INSTEAD of reading them from an account
   * (owner, 2026-11-16): "Promo et formation", "Statut", "Campus". Drawn for a guest on `/f/:id` and
   * for every respondent of an anonymous form, only when the form asks at least one; every field
   * drawn is required. On an anonymous form the hint says the answer stays anonymous: what is typed
   * here is declared, never joined to the account.
   */
  interface Props {
    /** The declared fields the form asks (`askedDeclaredFields`); nothing is drawn when empty. */
    asked: DeclaredField[];
    /** What the respondent chose, bound. */
    values: DeclaredValues;
    /** Whether to say what is wrong under each field: after a send was held, not while choosing. */
    showErrors: boolean;
    /** An anonymous form: the hint says nothing else links the answer to the account. */
    anonymous: boolean;
    disabled?: boolean;
  }

  let { asked, values = $bindable(), showErrors, anonymous, disabled = false }: Props = $props();

  const problem = (field: DeclaredField) =>
    showErrors ? (declaredProblem(field, values) ?? undefined) : undefined;
</script>

{#if asked.length > 0}
  <section
    id="declared-identity"
    class="border-cn-border mt-4 space-y-3 rounded-3xl border bg-(--cn-surface) p-5"
    data-testid="declared-identity-fields"
  >
    <div>
      <h2 class="text-text-main text-base font-bold">{m.form_respondent_declared_title()}</h2>
      <p class={CONTROL_HINT_CLASS}>
        {anonymous
          ? m.form_respondent_declared_hint_anonymous()
          : m.form_respondent_declared_hint()}
      </p>
    </div>
    {#if asked.includes('cursus')}
      <Select
        label={m.form_respondent_formation_label()}
        required
        {disabled}
        value={values.formation}
        options={formationOptions()}
        placeholder={respondentChoiceLabel('cursus')}
        onValueChange={(v) => {
          values.formation = v;
          if (v === NO_FORMATION) values.promo = '';
        }}
      />
      {#if values.formation !== NO_FORMATION}
        <Input
          type="number"
          name="declared-promo"
          label={m.form_respondent_promo_label()}
          required
          min={String(DECLARED_PROMO_MIN)}
          max={String(DECLARED_PROMO_MAX)}
          {disabled}
          bind:value={values.promo}
          error={problem('cursus')}
        />
      {:else if showErrors && problem('cursus')}
        <p class="text-red-err text-xs">{problem('cursus')}</p>
      {/if}
    {/if}
    {#if asked.includes('status')}
      <Select
        label={respondentChoiceLabel('status')}
        required
        {disabled}
        value={values.status}
        options={statusOptions()}
        hint={problem('status')}
        onValueChange={(v) => (values.status = v)}
      />
    {/if}
    {#if asked.includes('campus')}
      <Select
        label={respondentChoiceLabel('campus')}
        required
        {disabled}
        value={values.campus}
        options={campusOptions()}
        hint={problem('campus')}
        onValueChange={(v) => (values.campus = v)}
      />
    {/if}
  </section>
{/if}
