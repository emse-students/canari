<script lang="ts">
  import Input from '$lib/components/ui/Input.svelte';
  import { CONTROL_HINT_CLASS } from '$lib/components/ui/controlClasses';
  import {
    guestFieldLabel,
    guestFieldMaxLength,
    guestFieldProblem,
    type GuestIdentityField,
    type GuestIdentityValues,
  } from '$lib/forms/guestIdentity';
  import { m } from '$lib/paraglide/messages';

  /**
   * "Vos coordonnees" - the name and e-mail a PUBLIC form's creator asked of a guest (owner,
   * 2026-11-06). Drawn on `/f/:id` only when the form asks at least one; every field drawn is
   * required. The e-mail, when asked, is ALSO the address Lydia's payment request goes to, so the
   * page does not ask for it again at the payment step, and the field says so while the answer is
   * paid online ("Utilise aussi pour le recu Lydia").
   */
  interface Props {
    /** The fields the form asks, canonical (`askedGuestFields`); nothing is drawn when empty. */
    asked: GuestIdentityField[];
    /** What the guest typed, bound. */
    values: GuestIdentityValues;
    /** Whether to say what is wrong under each field: after a send was held, not while typing. */
    showErrors: boolean;
    /** Whether the answer is paid online: the e-mail is then the one Lydia's request goes to. */
    emailPaysLydia: boolean;
    disabled?: boolean;
  }

  let {
    asked,
    values = $bindable(),
    showErrors,
    emailPaysLydia,
    disabled = false,
  }: Props = $props();

  /** Autofill hints, so a phone offers the guest's own details. */
  const AUTOCOMPLETE: Record<GuestIdentityField, string> = {
    lastName: 'family-name',
    firstName: 'given-name',
    email: 'email',
  };
</script>

{#if asked.length > 0}
  <section
    id="guest-identity"
    class="border-cn-border mt-4 space-y-3 rounded-3xl border bg-(--cn-surface) p-5"
    data-testid="guest-identity-fields"
  >
    <div>
      <h2 class="text-text-main text-base font-bold">{m.form_guest_identity_title()}</h2>
      <p class={CONTROL_HINT_CLASS}>{m.form_guest_identity_hint()}</p>
    </div>
    {#each asked as field (field)}
      <div>
        <Input
          type={field === 'email' ? 'email' : 'text'}
          name={`guest-${field}`}
          autocomplete={AUTOCOMPLETE[field]}
          label={guestFieldLabel(field)}
          required
          maxlength={guestFieldMaxLength(field)}
          {disabled}
          bind:value={values[field]}
          error={showErrors ? (guestFieldProblem(field, values[field]) ?? undefined) : undefined}
        />
        {#if field === 'email' && emailPaysLydia}
          <p class={CONTROL_HINT_CLASS} data-testid="guest-email-lydia-note">
            {m.form_guest_identity_email_lydia_note()}
          </p>
        {/if}
      </div>
    {/each}
  </section>
{/if}
