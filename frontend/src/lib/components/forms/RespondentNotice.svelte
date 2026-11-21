<script lang="ts">
  import { UserRound } from '@lucide/svelte';
  import {
    joinedAccountFields,
    respondentChoiceLabel,
    transmittedFieldLabels,
    type AccountField,
    type DeclaredField,
  } from '$lib/forms/respondentFields';
  import { m } from '$lib/paraglide/messages';

  /**
   * WHAT REACHES THE ORGANISER WITH THIS ANSWER, SAID BEFORE IT IS SENT (owner, 2026-11-16;
   * principle 1 of the charter, docs/principes.md). A named form joins the account fields its
   * organiser ticked - read from the account by the server when the member sends, never typed here.
   * The member reads which ones before pressing the button; a form joining nothing draws nothing.
   */
  interface Props {
    /** The form's `respondentFields` as served (the cursus alone, or empty, on an anonymous form). */
    respondentFields: readonly string[] | null | undefined;
    /**
     * An anonymous form that joins the cursus says so in the words of its promise - the answer stays
     * anonymous, only the promo and formation, read from the account, go with it (owner, 2026-11-21).
     */
    anonymous?: boolean;
    /**
     * What this member is ASKED to declare on an anonymous form beside what is read from the account
     * (`askedOfMember`): the notice names it too, so it says exactly what goes with the answer.
     */
    declared?: readonly DeclaredField[];
  }

  let { respondentFields, anonymous = false, declared = [] }: Props = $props();

  const joined = $derived<AccountField[]>(joinedAccountFields(respondentFields));
</script>

{#if joined.length > 0}
  <p
    class="border-cn-border text-text-muted mt-4 flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm"
    data-testid="respondent-notice"
  >
    <UserRound size={16} class="mt-0.5 shrink-0" />
    <span>
      {#if anonymous && declared.length > 0}
        {m.form_respondent_notice_anonymous_mixed({
          fields: transmittedFieldLabels(joined).join(', '),
          declared: declared.map((f) => respondentChoiceLabel(f)).join(', '),
        })}
      {:else if anonymous}
        {m.form_respondent_notice_anonymous({ fields: transmittedFieldLabels(joined).join(', ') })}
      {:else}
        {m.form_respondent_notice({ fields: transmittedFieldLabels(joined).join(', ') })}
      {/if}
    </span>
  </p>
{/if}
