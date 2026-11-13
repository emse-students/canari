<script lang="ts">
  import { ClipboardList, TriangleAlert, Plus } from '@lucide/svelte';
  import type { Association } from '$lib/associations/api';
  import { loadAssociationForms } from '$lib/forms/associationForms';
  import type { Form } from '$lib/forms/api';
  import { editSectionHref } from '$lib/associations/editSections';
  import { m } from '$lib/paraglide/messages';
  import Button from '$lib/components/ui/Button.svelte';
  import FormsManagerList from '$lib/components/forms/FormsManagerList.svelte';

  /**
   * AN ASSOCIATION'S "Formulaires" TAB: the shared forms-management list (`FormsManagerList`)
   * scoped to this association, under its own header and the paid-forms banner. Everything a row
   * does - edit, share, QR, export, responses, cash validation, delete - is the list's, the SAME
   * as on `/forms`; this tab owns only what is about the association: the heading, the "new form"
   * link that creates a form already attached to it, and the payments warning.
   */
  interface Props {
    asso: Association;
    /** True once the payment account can collect online payments. */
    onlinePaymentsReady: boolean;
    /** Whether the caller can configure the payment account (tweaks the warning copy). */
    canManagePayoutAccount: boolean;
    /** Switches the parent to the Paiements tab. */
    onGoToPayments: () => void;
    /**
     * Set for a LIST, which has no Lydia account of its own and collects only through an accepted
     * payment delegation (owner, 2026-11-02): the not-ready banner then points at its delegation
     * section instead of a payout account it can never hold.
     */
    delegationHref?: string;
  }

  let { asso, onlinePaymentsReady, canManagePayoutAccount, onGoToPayments, delegationHref }: Props =
    $props();

  /** The create link carries the association and the way back to this tab. */
  const createHref = $derived(
    `/forms/create?association=${encodeURIComponent(asso.id)}&returnTo=${encodeURIComponent(
      editSectionHref(asso.slug, 'formulaires', asso.type === 'list' ? '/lists' : '/associations')
    )}`
  );
</script>

<div class="border-cn-border bg-cn-surface space-y-5 rounded-2xl border p-6 shadow-sm">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h2 class="text-text-main flex items-center gap-2 text-lg font-bold">
        <ClipboardList size={20} />
        {m.asso_forms_title()}
      </h2>
      <p class="text-text-muted mt-1 text-sm">
        {m.asso_forms_subtitle()}
      </p>
    </div>
    <Button href={createHref}>
      <Plus size={16} />
      {m.asso_forms_new_form_button()}
    </Button>
  </div>

  <FormsManagerList
    load={() => loadAssociationForms(asso.id)}
    {createHref}
    scoped
    inset
    paymentsReady={onlinePaymentsReady}
    headingTag="h3"
  >
    {#snippet notice(forms: Form[])}
      {#if forms.some((f) => f.basePrice > 0) && !onlinePaymentsReady}
        <div
          class="border-amber-warn/30 bg-amber-warn/10 text-amber-warn-text mb-3 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm"
        >
          <TriangleAlert size={15} class="mt-0.5 shrink-0" />
          <span>
            {#if delegationHref}
              {m.list_delegate_required_banner()}
              <a href={delegationHref} class="font-semibold underline hover:no-underline"
                >{m.list_delegate_required_link()}</a
              >
            {:else if canManagePayoutAccount}
              {m.asso_forms_payments_missing_can_manage_prefix()}<strong
                >{m.asso_forms_payments_missing_strong()}</strong
              >{m.asso_forms_payments_missing_suffix()}<button
                type="button"
                data-testid="payments-link"
                class="inline p-0 text-start font-semibold underline hover:no-underline"
                onclick={onGoToPayments}>{m.asso_forms_payments_configure_link()}</button
              >.
            {:else}
              {m.asso_forms_payments_missing_no_manage()}
            {/if}
          </span>
        </div>
      {/if}
    {/snippet}
  </FormsManagerList>
</div>
