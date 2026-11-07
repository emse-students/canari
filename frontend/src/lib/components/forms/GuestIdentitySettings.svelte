<script lang="ts">
  import CheckboxGroup from '$lib/components/ui/CheckboxGroup.svelte';
  import { CONTROL_HINT_CLASS } from '$lib/components/ui/controlClasses';
  import {
    GUEST_IDENTITY_FIELDS,
    guestFieldLabel,
    guestFieldsAdvice,
  } from '$lib/forms/guestIdentity';
  import { m } from '$lib/paraglide/messages';

  /**
   * "Demander aux invites : Nom / Prenom / E-mail" (owner, 2026-11-06) - what a PUBLIC form asks a
   * guest about who they are. Three independent boxes, all off by default; each ticked one is
   * required of a guest on `/f/:id`, and a member never sees them.
   *
   * Drawn under the "Formulaire public" switch and only while it is on: on a form nobody answers
   * without an account, the boxes would ask nobody. The advice says WHY to tick them, more firmly on
   * a form that charges - an organiser otherwise has only a reference to find who ordered.
   */
  interface Props {
    /** The ticked fields, bound: drawn from `lastName`, `firstName`, `email`. */
    guestFields: string[];
    /** Whether the form is answerable without an account; nothing is drawn otherwise. */
    isPublic: boolean;
    /** An anonymous form keeps nobody's identity, so it asks a guest none (the server refuses it). */
    anonymous: boolean;
    /** Whether the form takes money: the advice is firmer then. */
    charges: boolean;
  }

  let { guestFields = $bindable(), isPublic, anonymous, charges }: Props = $props();

  const options = GUEST_IDENTITY_FIELDS.map((field) => ({
    value: field,
    label: guestFieldLabel(field),
  }));
  const advice = $derived(guestFieldsAdvice(isPublic, charges, guestFields));
</script>

{#if isPublic}
  <div
    class="border-cn-border space-y-2 rounded-xl border px-3 py-3"
    data-testid="guest-identity-settings"
  >
    {#if anonymous}
      <p class={CONTROL_HINT_CLASS}>{m.form_guest_identity_blocked_anonymous()}</p>
    {:else}
      <CheckboxGroup
        label={m.form_guest_identity_settings_label()}
        {options}
        bind:selected={guestFields}
        hint={m.form_guest_identity_settings_hint()}
      />
      {#if advice === 'paid'}
        <p
          class="border-cn-yellow/30 bg-cn-yellow/5 text-text-main rounded-xl border px-3 py-2 text-xs font-semibold"
          data-testid="guest-identity-advice"
        >
          {m.form_guest_identity_advice_paid()}
        </p>
      {:else if advice === 'suggested'}
        <p class={CONTROL_HINT_CLASS} data-testid="guest-identity-advice">
          {m.form_guest_identity_advice()}
        </p>
      {/if}
    {/if}
  </div>
{/if}
