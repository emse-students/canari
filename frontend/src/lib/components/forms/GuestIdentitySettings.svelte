<script lang="ts">
  import CheckboxGroup from '$lib/components/ui/CheckboxGroup.svelte';
  import { CONTROL_HINT_CLASS } from '$lib/components/ui/controlClasses';
  import { guestFieldsAdvice } from '$lib/forms/guestIdentity';
  import {
    coherentChoices,
    offeredChoices,
    respondentChoiceLabel,
  } from '$lib/forms/respondentFields';
  import { m } from '$lib/paraglide/messages';

  /**
   * "Qui a repondu" - which of the respondent's fields travel with each answer (owner, 2026-11-16),
   * built on the "Demander aux invites" block of 2026-11-06. ONE set of ticks: Nom, Prenom, E-mail
   * (a public form's guests), Promo et formation, Statut, Campus. For a signed-in member of a named
   * form the ticked fields are read from the account when they send; whoever the form cannot read
   * from an account - a guest, any respondent of an anonymous form - is asked them. The save turns
   * the set into the two lists the server keeps (`respondentSettingsPayload`).
   *
   * An anonymous form offers no name nor e-mail: it promised not to keep who answered. The e-mail is
   * a guest's only: Canari keeps none for a member. The advice says why to tick something on a
   * public form, more firmly on one that charges.
   */
  interface Props {
    /** The ticked choices, bound: drawn from the choices `respondentFields.ts` offers. */
    choices: string[];
    /** Whether the form is answerable without an account: the e-mail is offered then. */
    isPublic: boolean;
    /** An anonymous form asks its respondents instead of joining an account, and never a name. */
    anonymous: boolean;
    /** Whether the form takes money: the advice is firmer then. */
    charges: boolean;
  }

  let { choices = $bindable(), isPublic, anonymous, charges }: Props = $props();

  const options = $derived(
    offeredChoices(isPublic, anonymous).map((choice) => ({
      value: choice,
      label: respondentChoiceLabel(choice),
    }))
  );
  // The advice is about telling GUESTS apart, so it reads the names and e-mail only.
  const advice = $derived(
    guestFieldsAdvice(
      isPublic && !anonymous,
      charges,
      choices.filter((c) => c === 'lastName' || c === 'firstName' || c === 'email')
    )
  );
</script>

<div
  class="border-cn-border space-y-2 rounded-xl border px-3 py-3"
  data-testid="guest-identity-settings"
>
  <CheckboxGroup
    label={m.form_respondent_settings_label()}
    {options}
    bind:selected={() => choices, (next) => (choices = coherentChoices(choices, next))}
    hint={anonymous
      ? m.form_respondent_settings_hint_anonymous()
      : m.form_respondent_settings_hint()}
  />
  {#if anonymous && choices.includes('cursusFromAccount')}
    <p class={CONTROL_HINT_CLASS} data-testid="cursus-from-account-note">
      {m.form_respondent_cursus_from_account_note()}
      {m.form_respondent_cursus_from_account_ticks_cursus()}
    </p>
  {/if}
  {#if advice === 'paid'}
    <p
      class="border-accent/30 bg-accent/5 text-text-main rounded-xl border px-3 py-2 text-xs font-semibold"
      data-testid="guest-identity-advice"
    >
      {m.form_guest_identity_advice_paid()}
    </p>
  {:else if advice === 'suggested'}
    <p class={CONTROL_HINT_CLASS} data-testid="guest-identity-advice">
      {m.form_guest_identity_advice()}
    </p>
  {/if}
</div>
