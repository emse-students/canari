<script lang="ts">
  import { UserRound } from '@lucide/svelte';
  import {
    joinedAccountFields,
    transmittedFieldLabels,
    type AccountField,
  } from '$lib/forms/respondentFields';
  import { m } from '$lib/paraglide/messages';

  /**
   * WHAT REACHES THE ORGANISER WITH THIS ANSWER, SAID BEFORE IT IS SENT (owner, 2026-11-16;
   * principle 1 of the charter, docs/principes.md). A named form joins the account fields its
   * organiser ticked - read from the account by the server when the member sends, never typed here.
   * The member reads which ones before pressing the button; a form joining nothing draws nothing.
   */
  interface Props {
    /** The form's `respondentFields` as served (empty on an anonymous form). */
    respondentFields: readonly string[] | null | undefined;
  }

  let { respondentFields }: Props = $props();

  const joined = $derived<AccountField[]>(joinedAccountFields(respondentFields));
</script>

{#if joined.length > 0}
  <p
    class="border-cn-border text-text-muted mt-4 flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm"
    data-testid="respondent-notice"
  >
    <UserRound size={16} class="mt-0.5 shrink-0" />
    <span>{m.form_respondent_notice({ fields: transmittedFieldLabels(joined).join(', ') })}</span>
  </p>
{/if}
