<script lang="ts">
  /**
   * THE FORMS-MANAGEMENT LIST - ONE COMPONENT FOR `/forms` AND FOR AN ASSOCIATION'S "Formulaires"
   * TAB (owner, 2026-11-13: the two screens had drifted into different products).
   *
   * It carries the UNION of what each side could do: edit, the respondent view, the share link, the
   * QR code, the export, the responses accordion (answers, payment actions, deleting an answer),
   * the cash payments awaiting validation, the price line, the draft and unpublished-changes states
   * and the delete. Scope is data, not a fork: `/forms` hands it every form the caller manages and
   * each row names its association; the tab hands it one association's forms (`scoped`), the name
   * is then implied and omitted.
   *
   * ROW SHAPE: the name has the whole width. The two actions managers use most - "Modifier" and
   * "Reponses" - stay on the row WITH their words, and the rest hide behind one "..." (`FormRowMenu`).
   * Six icon-only buttons forced a guess at what each glyph meant; three text buttons never fit a
   * phone beside a name. The row answers its OWN width (`@container`), not the window's, so the same
   * row is right in the narrow settings column and on the wide page.
   */
  import { onMount, tick, untrack } from 'svelte';
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import { ChevronUp, FileText, Pencil, Plus, TriangleAlert, Users } from '@lucide/svelte';
  import { intlLocale } from '$lib/utils/intlLocale';
  import { FORM_RESPONSES_PARAM } from '$lib/forms/responsesLink';
  import { Log } from '$lib/utils/Log';
  import { showToast } from '$lib/stores/toast.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import {
    getSubmissions,
    deleteForm,
    deleteSubmission,
    listPendingCashSubmissions,
    validateCashSubmission,
    cancelCashSubmission,
    type Form,
    type Submission,
    type PendingCashSubmission,
    type SubmissionsExportFormat,
  } from '$lib/forms/api';
  import { formSharePath } from '$lib/forms/shareLink';
  import { downloadFormExport } from '$lib/forms/exportEntries';
  import { copyPublicShareLink } from '$lib/utils/copyShareLink';
  import { publicAppUrl } from '$lib/utils/publicAppUrl';
  import QrCodeModal from '$lib/components/shared/QrCodeModal.svelte';
  import { m } from '$lib/paraglide/messages';
  import { submitterName } from '$lib/forms/submissionTable';
  import { formCodeMessage } from '$lib/forms/answerBounds';
  import { PREVIOUS_PAYMENT_OPEN } from '$lib/associations/paymentRefusal';
  import { refusalCode } from '$lib/utils/apiRefusal';
  import FormResponsesPanel from '$lib/components/forms/FormResponsesPanel.svelte';
  import FormRowMenu from '$lib/components/forms/FormRowMenu.svelte';
  import { productGridQuestions } from '$lib/forms/responsesView';
  import { formViewHref, isDraftForm } from '$lib/forms/publish';
  import Button from '$lib/components/ui/Button.svelte';
  import { markdownToPlainText } from '$lib/seo/text';

  interface Props {
    /** Reads the forms to list; the list owns the loading state and the error line. */
    load: () => Promise<Form[]>;
    /**
     * Where the empty state's "create" button goes. Absent when the screen already draws one (the
     * tab's header has "Nouveau formulaire"): the empty state then draws none, never a second.
     */
    createHref?: string;
    /**
     * One association's list (its tab): the association name is implied, so rows omit it. Without
     * it a row says whose form it is, by NAME - the list covers every association the caller
     * manages, so a row that only said its title would leave the caller guessing.
     */
    scoped?: boolean;
    /** A tab inside a card draws its rows inset (`bg-cn-bg`) so they read against the card. */
    inset?: boolean;
    /**
     * False when the payment account cannot collect yet: a PAID row then carries the "not
     * configured" warning. Absent (the global list spans associations) draws no warning.
     */
    paymentsReady?: boolean;
    /** The row's heading level: the page has an `h1` above (`h2`), the tab an `h2` above (`h3`). */
    headingTag?: 'h2' | 'h3';
    /** Drawn above the rows once the forms are known (the tab's "payments not configured" banner). */
    notice?: Snippet<[Form[]]>;
    /** Told when the forms are loaded or one is deleted (the page's count). */
    onForms?: (forms: Form[]) => void;
  }

  let {
    load,
    createHref,
    scoped = false,
    inset = false,
    paymentsReady,
    headingTag = 'h2',
    notice,
    onForms,
  }: Props = $props();

  let forms = $state<Form[]>([]);
  let loading = $state(true);
  let loadError = $state(false);
  let deletingId = $state<string | null>(null);
  /** The form whose export is in flight: a second tap starts no second export. */
  let exportingId = $state<string | null>(null);
  let deletingSubmissionId = $state<string | null>(null);
  /** The form whose QR code is open, or null. */
  let qrForm = $state<Form | null>(null);
  /** Which responses accordions are open. */
  let expandedForms = $state<Record<string, boolean>>({});
  /** Lazy-loaded submissions per form: undefined = not loaded, 'loading', 'error', or the rows. */
  let submissionsData = $state<Record<string, Submission[] | 'loading' | 'error'>>({});
  /** Cash payments awaiting validation, per form that accepts cash. */
  let pendingCash = $state<Record<string, PendingCashSubmission[]>>({});

  function setForms(next: Form[]) {
    forms = next;
    onForms?.(next);
  }

  onMount(async () => {
    try {
      setForms(await load());
      // The cash strip is the tab's: one association's forms, a handful of reads. `/forms` spans
      // every association the caller manages, so it would fire one read per cash form on EVERY
      // open; there, cash is validated in the responses accordion, which holds the same actions.
      if (scoped) void loadPendingCash(forms.filter((f) => f.allowCashPayment));
    } catch (e) {
      Log.w('FormsManagerList', `loading the forms failed: ${e}`);
      loadError = true;
    } finally {
      loading = false;
    }
  });

  /** Reads the pending cash of each form that takes cash; a form that fails is logged and empty. */
  async function loadPendingCash(cashForms: Form[]) {
    const entries = await Promise.all(
      cashForms.map(async (f) => {
        try {
          return [f.id, await listPendingCashSubmissions(f.id)] as const;
        } catch (e) {
          Log.w('FormsManagerList', `pending cash of form ${f.id.slice(0, 8)} failed: ${e}`);
          return [f.id, []] as const;
        }
      })
    );
    pendingCash = { ...pendingCash, ...Object.fromEntries(entries) };
  }

  const priceLine = (form: Form) =>
    form.basePrice > 0 ? `${(form.basePrice / 100).toFixed(2)} €` : m.asso_forms_price_free();

  async function handleDelete(form: Form) {
    // Guarded from the moment the confirmation OPENS: two quick selections would otherwise queue
    // two confirmations, and the second delete would 404 on a form already gone.
    if (deletingId === form.id) return;
    deletingId = form.id;
    if (
      !(await showConfirm(m.form_list_delete_confirm({ title: form.title }), {
        danger: true,
        confirmLabel: m.common_delete_button(),
      }))
    ) {
      deletingId = null;
      return;
    }
    try {
      await deleteForm(form.id);
      setForms(forms.filter((f) => f.id !== form.id));
    } catch (e) {
      console.error(`[FORMS] deleting form ${form.id.slice(0, 8)} failed:`, e);
      showToast(m.form_list_error_delete());
    } finally {
      deletingId = null;
    }
  }

  /**
   * Re-reads one form's answers and pending cash after a payment action (cash marked paid, a
   * refund), so the cards, the filters and the totals follow. A failure keeps what is shown.
   */
  async function reloadResponses(form: Form) {
    try {
      submissionsData = { ...submissionsData, [form.id]: await getSubmissions(form.id) };
    } catch (e) {
      console.error(`[FORMS] re-reading the answers of form ${form.id.slice(0, 8)} failed:`, e);
      showToast(m.form_list_responses_error());
    }
    if (scoped && form.allowCashPayment) await loadPendingCash([form]);
  }

  /** Toggles the responses accordion; loads data on first open. */
  async function toggleResponses(formId: string) {
    const isOpen = expandedForms[formId];
    expandedForms = { ...expandedForms, [formId]: !isOpen };
    if (isOpen || submissionsData[formId] != null) return;
    submissionsData = { ...submissionsData, [formId]: 'loading' };
    try {
      submissionsData = { ...submissionsData, [formId]: await getSubmissions(formId) };
    } catch (e) {
      console.error(`[FORMS] loading the answers of form ${formId.slice(0, 8)} failed:`, e);
      submissionsData = { ...submissionsData, [formId]: 'error' };
    }
  }

  /** The form a `?responses=` link last opened, so one link opens its accordion once. */
  let openedFromLink: string | null = null;

  /**
   * A LINK NAMING ONE FORM'S RESPONSES (`responsesLink.ts`) - the organiser alert for a payment
   * over capacity, from the bell or a push tap - opens that accordion once the list has loaded, and
   * brings it into view. A form the list does not hold (deleted, or not this reader's to manage) is
   * said in the log (`Log.i`, so it reaches the in-app log a device reading sees) rather than
   * guessed at: the list stays as it is.
   */
  $effect(() => {
    const wanted = page.url.searchParams.get(FORM_RESPONSES_PARAM);
    if (loading || !wanted || wanted === openedFromLink) return;
    openedFromLink = wanted;
    untrack(() => void openResponsesFromLink(wanted));
  });

  async function openResponsesFromLink(formId: string) {
    if (!forms.some((f) => f.id === formId)) {
      Log.i('forms.responsesLink', `form ${formId} is not on this list - nothing opened`);
      return;
    }
    if (!expandedForms[formId]) await toggleResponses(formId);
    await tick();
    document.getElementById(`form-${formId}`)?.scrollIntoView({ block: 'start' });
  }

  async function handleDeleteSubmission(formId: string, sub: Submission) {
    // An anonymous answer is deleted by its content and its day alone: there is no one to name.
    const prompt = sub.userId
      ? m.form_list_delete_submission_confirm({ name: submitterName(sub) })
      : m.form_list_delete_anonymous_submission_confirm();
    if (
      !(await showConfirm(prompt, {
        danger: true,
        confirmLabel: m.common_delete_button(),
      }))
    )
      return;
    deletingSubmissionId = sub.id;
    try {
      await deleteSubmission(sub.id);
      const current = submissionsData[formId];
      if (Array.isArray(current)) {
        submissionsData = { ...submissionsData, [formId]: current.filter((s) => s.id !== sub.id) };
      }
    } catch (e) {
      // A paid answer is refused with a typed code (FORM_ANSWER_PAID), and a pending one whose Lydia
      // request could not be settled first with PREVIOUS_PAYMENT_OPEN: expected answers, said to the
      // manager, never an error.
      const code = refusalCode(e);
      const coded =
        code === PREVIOUS_PAYMENT_OPEN ? m.form_list_delete_payment_open() : formCodeMessage(code);
      if (coded) {
        Log.w('FormsManagerList', `deleting answer ${sub.id.slice(0, 8)} refused: ${code}`);
      } else {
        console.error(`[FORMS] deleting answer ${sub.id.slice(0, 8)} failed:`, e);
      }
      showToast(coded ?? m.form_list_error_delete());
    } finally {
      deletingSubmissionId = null;
    }
  }

  /** Drops one cash row from a form's pending list, and refreshes its open accordion. */
  async function settleCash(form: Form, subId: string) {
    pendingCash = {
      ...pendingCash,
      [form.id]: (pendingCash[form.id] ?? []).filter((s) => s.id !== subId),
    };
    if (Array.isArray(submissionsData[form.id])) await reloadResponses(form);
  }

  async function validateCash(form: Form, subId: string) {
    try {
      await validateCashSubmission(form.id, subId);
      await settleCash(form, subId);
    } catch (e) {
      console.error(`[FORMS] validating cash ${subId.slice(0, 8)} failed:`, e);
      showToast(m.common_generic_error_label());
    }
  }

  async function cancelCash(form: Form, subId: string) {
    if (
      !(await showConfirm(m.asso_forms_cancel_cash_confirm(), {
        danger: true,
        confirmLabel: m.asso_forms_cancel_cash_confirm_button(),
        cancelLabel: m.asso_forms_cancel_cash_cancel(),
      }))
    )
      return;
    try {
      await cancelCashSubmission(form.id, subId);
      await settleCash(form, subId);
    } catch (e) {
      console.error(`[FORMS] cancelling cash ${subId.slice(0, 8)} failed:`, e);
      showToast(m.common_generic_error_label());
    }
  }

  function copyFormLink(form: Form) {
    void copyPublicShareLink(formSharePath(form));
  }

  function openView(form: Form) {
    window.open(formViewHref(form, !!form.hasUnpublishedChanges), '_blank', 'noopener');
  }

  async function exportForm(form: Form, format: SubmissionsExportFormat) {
    if (exportingId === form.id) return;
    exportingId = form.id;
    try {
      await downloadFormExport(form.id, form.title, format);
    } finally {
      exportingId = null;
    }
  }
</script>

{#if loading}
  <div class="flex justify-center py-16">
    <div
      class="border-accent-icon h-10 w-10 animate-spin rounded-full border-4 border-t-transparent"
    ></div>
  </div>
{:else if loadError}
  <div
    class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm"
    data-testid="forms-load-error"
  >
    {m.common_load_error()}
  </div>
{:else}
  {@render notice?.(forms)}
  {#if forms.length === 0}
    <div
      class="border-cn-border rounded-2xl border-2 border-dashed bg-(--cn-surface) px-8 py-16 text-center"
      data-testid="forms-empty"
    >
      <div
        class="bg-accent/15 text-cn-dark mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl"
      >
        <FileText size={28} />
      </div>
      <p class="text-text-muted mb-1 font-medium">{m.form_list_empty_title()}</p>
      <p class="text-text-muted/60 mb-4 text-sm">{m.form_list_empty_desc()}</p>
      {#if createHref}
        <Button href={createHref}>
          <Plus size={16} />
          {m.form_list_create_button()}
        </Button>
      {/if}
    </div>
  {:else}
    <ul class="space-y-3">
      {#each forms as form (form.id)}
        {@const draft = isDraftForm(form)}
        <li
          id="form-{form.id}"
          class="border-cn-border @container rounded-2xl border-2 transition-colors {inset
            ? 'bg-cn-bg'
            : 'bg-(--cn-surface)'} {expandedForms[form.id]
            ? 'border-accent/40'
            : 'hover:border-accent/40'}"
          data-testid="form-row"
        >
          <div
            class="flex flex-col gap-3 p-4 @md:flex-row @md:items-center @md:p-5"
            data-testid="form-card-header"
          >
            <div class="min-w-0 flex-1" data-testid="form-card-title">
              <svelte:element
                this={headingTag}
                class="text-text-main line-clamp-2 min-w-0 font-bold break-words"
              >
                {form.title}
              </svelte:element>
              {#if form.description}
                <p class="text-text-muted mt-0.5 line-clamp-2 text-sm">
                  {markdownToPlainText(form.description)}
                </p>
              {/if}
              <p class="text-text-muted mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                {priceLine(form)}{form.allowCashPayment ? ` · ${m.asso_forms_cash_accepted()}` : ''}
                {#if form.basePrice > 0 && paymentsReady === false}
                  <span
                    class="text-amber-warn-text inline-flex items-center gap-1 font-medium"
                    title={m.asso_forms_payments_not_configured_title()}
                  >
                    <TriangleAlert size={11} />
                    {m.asso_forms_payments_not_configured_badge()}
                  </span>
                {/if}
              </p>
              <!-- The states read the SAME on both screens: the draft marker (the managers' alone:
                   nobody links it believing it live) and, on a published form, the unpublished
                   edits waiting. Whose form it is is named only where it is not implied. -->
              <p class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs font-semibold">
                {#if !scoped}
                  {#if form.associationName}
                    <span
                      class="bg-accent/15 text-cn-dark inline-flex items-center gap-1 rounded-full px-2 py-0.5"
                    >
                      <Users size={11} />
                      {m.form_list_association_badge({ association: form.associationName })}
                    </span>
                  {:else}
                    <span
                      class="bg-cn-border/40 text-text-muted inline-flex rounded-full px-2 py-0.5"
                    >
                      {m.form_list_personal_badge()}
                    </span>
                  {/if}
                {/if}
                {#if draft}
                  <span
                    class="border-cn-border text-text-main inline-flex rounded-full border border-dashed px-2 py-0.5"
                    data-testid="form-draft-badge"
                  >
                    {m.form_status_draft_badge()}
                  </span>
                {:else if form.hasUnpublishedChanges}
                  <span
                    class="border-cn-border text-text-main inline-flex rounded-full border border-dashed px-2 py-0.5"
                    data-testid="form-unpublished-badge"
                  >
                    {m.form_unpublished_changes_badge()}
                  </span>
                {/if}
              </p>
            </div>
            <!-- Two labelled actions and the "..." - ONE ROW at every width. Under the card's `md`
                 the two labelled ones share the row equally; from `md` they keep their own box
                 beside the name. -->
            <div
              class="flex items-stretch gap-2 @md:shrink-0 [&>a]:flex-1 @md:[&>a]:flex-none [&>button]:flex-1 @md:[&>button]:flex-none [&>span]:flex-none"
              data-testid="form-card-actions"
            >
              <Button variant="secondary" href="/forms/{form.id}/edit" data-testid="form-edit-link">
                <Pencil size={16} />
                {m.form_list_edit_button()}
              </Button>
              <Button
                variant="secondary"
                onclick={() => toggleResponses(form.id)}
                aria-expanded={!!expandedForms[form.id]}
                data-testid="form-responses-toggle"
              >
                {#if expandedForms[form.id]}
                  <ChevronUp size={16} />
                {:else}
                  <Users size={16} />
                {/if}
                {m.form_list_responses_button()}
              </Button>
              <FormRowMenu
                isDraft={draft}
                hasProductGrid={productGridQuestions(form.items ?? []).length > 0}
                deleting={deletingId === form.id}
                exporting={exportingId === form.id}
                onView={() => openView(form)}
                onCopyLink={() => copyFormLink(form)}
                onQr={() => (qrForm = form)}
                onExport={(format) => void exportForm(form, format)}
                onDelete={() => void handleDelete(form)}
              />
            </div>
          </div>

          {#if scoped && pendingCash[form.id]?.length}
            <div class="border-cn-border space-y-2 border-t-2 px-4 py-3 @md:px-5">
              <p class="text-amber-warn-text flex items-center gap-1.5 text-xs font-bold">
                <TriangleAlert size={13} />
                {m.asso_forms_pending_cash_label({ count: pendingCash[form.id].length })}
              </p>
              <ul class="space-y-2">
                {#each pendingCash[form.id] as sub (sub.id)}
                  <li
                    class="border-amber-warn/30 bg-amber-warn/10 flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2"
                  >
                    <div class="min-w-0 flex-1">
                      <p class="text-text-main truncate text-xs font-semibold">
                        {submitterName(sub)}
                      </p>
                      <p class="text-text-muted text-xs">
                        {(sub.totalPaid / 100).toFixed(2)} € · {new Date(
                          sub.createdAt
                        ).toLocaleDateString(intlLocale())}
                      </p>
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                      <Button
                        size="compact"
                        variant="secondary"
                        onclick={() => validateCash(form, sub.id)}
                      >
                        {m.common_validate_button()}
                      </Button>
                      <Button
                        size="compact"
                        variant="danger-outline"
                        onclick={() => cancelCash(form, sub.id)}
                      >
                        {m.common_cancel_button()}
                      </Button>
                    </div>
                  </li>
                {/each}
              </ul>
            </div>
          {:else if scoped && form.allowCashPayment && pendingCash[form.id]}
            <p class="text-text-muted border-cn-border border-t-2 px-4 py-3 text-xs @md:px-5">
              {m.asso_forms_no_pending_cash()}
            </p>
          {/if}

          {#if expandedForms[form.id]}
            <div class="border-cn-border border-t-2 px-4 py-4 @md:px-5">
              {#if submissionsData[form.id] === 'loading'}
                <div class="flex justify-center py-4">
                  <div
                    class="border-accent-icon h-6 w-6 animate-spin rounded-full border-2 border-t-transparent"
                  ></div>
                </div>
              {:else if submissionsData[form.id] === 'error'}
                <p class="text-red-err py-2 text-center text-sm">
                  {m.form_list_responses_error()}
                </p>
              {:else if Array.isArray(submissionsData[form.id]) && (submissionsData[form.id] as Submission[]).length === 0}
                <p class="text-text-muted py-2 text-center text-sm">
                  {m.form_list_responses_empty()}
                </p>
              {:else if Array.isArray(submissionsData[form.id])}
                <FormResponsesPanel
                  {form}
                  submissions={submissionsData[form.id] as Submission[]}
                  deletingId={deletingSubmissionId}
                  onDelete={(sub) => void handleDeleteSubmission(form.id, sub)}
                  onReload={() => reloadResponses(form)}
                />
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
{/if}

{#if qrForm}
  <QrCodeModal
    open
    url={publicAppUrl(formSharePath(qrForm))}
    label={qrForm.title}
    owner={qrForm.associationName}
    intro={m.form_qr_intro()}
    onClose={() => (qrForm = null)}
  />
{/if}
