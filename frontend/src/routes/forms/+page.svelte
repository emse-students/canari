<script lang="ts">
  import { onMount } from 'svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import {
    exportSubmissions,
    getForms,
    getSubmissions,
    deleteForm,
    deleteSubmission,
    type Form,
    type Submission,
  } from '$lib/forms/api';
  import {
    Plus,
    Download,
    FileText,
    Pencil,
    Link,
    Check,
    QrCode,
    Trash2,
    ChevronDown,
    ChevronUp,
    Users,
    X,
  } from '@lucide/svelte';
  import { copyPublicShareLink } from '$lib/utils/copyShareLink';
  import { publicAppUrl } from '$lib/utils/publicAppUrl';
  import QrCodeModal from '$lib/components/shared/QrCodeModal.svelte';
  import { downloadDecryptedFile } from '$lib/utils/fileDownload';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';

  let copiedId = $state<string | null>(null);
  /** The form whose QR code is open, or null. Both share controls point at the same path. */
  let qrForm = $state<Form | null>(null);

  /** The one place this screen says where a form lives, so the two share controls cannot drift. */
  function formPath(id: string): string {
    return `/forms/${id}`;
  }

  function copyFormLink(id: string) {
    void copyPublicShareLink(formPath(id));
    copiedId = id;
    setTimeout(() => {
      copiedId = null;
    }, 2000);
  }

  let forms = $state<Form[]>([]);
  let loading = $state(true);
  let deletingId = $state<string | null>(null);
  let deletingSubmissionId = $state<string | null>(null);

  /** Tracks which form accordions are open. */
  let expandedForms = $state<Record<string, boolean>>({});
  /** Lazy-loaded submissions per form: undefined = not loaded, 'loading', 'error', or array. */
  let submissionsData = $state<Record<string, Submission[] | 'loading' | 'error'>>({});

  onMount(async () => {
    try {
      forms = await getForms();
    } catch {
      // Unauthenticated or API unavailable - leave empty
    } finally {
      loading = false;
    }
  });

  async function handleDelete(id: string, title: string) {
    if (
      !(await showConfirm(m.form_list_delete_confirm({ title }), {
        danger: true,
        confirmLabel: m.common_delete_button(),
      }))
    )
      return;
    deletingId = id;
    try {
      await deleteForm(id);
      forms = forms.filter((f) => f.id !== id);
    } catch {
      showToast(m.form_list_error_delete());
    } finally {
      deletingId = null;
    }
  }

  async function handleExport(id: string) {
    try {
      await downloadDecryptedFile(await exportSubmissions(id), `submissions_${id}.xlsx`);
    } catch {
      showToast(m.form_list_error_export());
    }
  }

  /** Toggles the responses accordion; loads data on first open. */
  async function toggleResponses(formId: string) {
    const isOpen = expandedForms[formId];
    expandedForms = { ...expandedForms, [formId]: !isOpen };
    if (isOpen || submissionsData[formId] != null) return;
    submissionsData = { ...submissionsData, [formId]: 'loading' };
    try {
      const data = await getSubmissions(formId);
      submissionsData = { ...submissionsData, [formId]: data };
    } catch {
      submissionsData = { ...submissionsData, [formId]: 'error' };
    }
  }

  async function handleDeleteSubmission(formId: string, sub: Submission) {
    const name =
      [sub.firstName, sub.lastName].filter(Boolean).join(' ') || getUserDisplayNameSync(sub.userId);
    if (
      !(await showConfirm(m.form_list_delete_submission_confirm({ name }), {
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
    } catch {
      showToast(m.form_list_error_delete());
    } finally {
      deletingSubmissionId = null;
    }
  }

  /** Formats an ISO date string as "DD/MM/YYYY HH:MM". */
  function formatDate(iso: string): string {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** Returns a human-readable label for a payment status. */
  function statusLabel(s: string): string {
    if (s === 'free') return m.form_status_free();
    if (s === 'pending') return m.form_status_pending();
    if (s === 'pending_cash') return m.form_status_pending_cash();
    if (s === 'paid') return m.form_status_paid();
    if (s === 'cancelled') return m.form_status_cancelled();
    if (s === 'expired') return m.form_status_expired();
    return s;
  }

  /** Formats cents as a currency string, or "-" for zero. */
  function formatAmount(cents: number): string {
    if (!cents) return '-';
    return (cents / 100).toLocaleString(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
      style: 'currency',
      currency: 'eur',
    });
  }
</script>

<div class="mx-auto max-w-3xl px-4 py-6 sm:px-6">
  <div class="mb-8 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
    <div>
      <h1 class="text-text-main text-2xl font-extrabold tracking-tight">{m.form_list_title()}</h1>
      <p class="text-text-muted mt-0.5 text-sm">
        {forms.length === 1 ? m.form_list_count_one() : m.form_list_count({ count: forms.length })}
      </p>
    </div>
    <a
      href="/forms/create"
      class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 self-start rounded-xl px-5 py-2.5 text-sm font-bold transition-colors sm:self-auto"
    >
      <Plus size={16} />
      {m.form_list_new_button()}
    </a>
  </div>

  {#if loading}
    <div class="flex justify-center py-16">
      <div
        class="border-cn-yellow h-10 w-10 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if forms.length === 0}
    <div
      class="border-cn-border rounded-2xl border-2 border-dashed bg-(--cn-surface) px-8 py-16 text-center"
    >
      <div
        class="bg-cn-yellow/15 text-cn-dark mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl"
      >
        <FileText size={28} />
      </div>
      <p class="text-text-muted mb-1 font-medium">{m.form_list_empty_title()}</p>
      <p class="text-text-muted/60 mb-4 text-sm">
        {m.form_list_empty_desc()}
      </p>
      <a
        href="/forms/create"
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition-colors"
      >
        <Plus size={16} />
        {m.form_list_create_button()}
      </a>
    </div>
  {:else}
    <div class="space-y-3">
      {#each forms as form (form.id)}
        <div
          class="border-cn-border rounded-2xl border-2 bg-(--cn-surface) transition-colors {expandedForms[
            form.id
          ]
            ? 'border-cn-yellow/40'
            : 'hover:border-cn-yellow/40'}"
        >
          <!-- Card header -->
          <div class="flex flex-col gap-3 p-5 sm:flex-row sm:items-center">
            <div class="min-w-0 flex-1">
              <h2 class="text-text-main truncate font-bold">{form.title}</h2>
              {#if form.description}
                <p class="text-text-muted mt-0.5 truncate text-sm">{form.description}</p>
              {/if}
              <!-- Whose form this is, by NAME. The list covers association forms reachable
                   through MANAGE_FORMS, so a row that only said its title would leave the
                   caller guessing. This line used to print the raw form id, which told a
                   person nothing and leaked an internal handle. -->
              <p class="mt-1.5 flex items-center gap-1.5 text-xs font-semibold">
                {#if form.associationName}
                  <span
                    class="bg-cn-yellow/15 text-cn-dark inline-flex items-center gap-1 rounded-full px-2 py-0.5"
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
              </p>
            </div>
            <div class="flex shrink-0 flex-wrap gap-2">
              <a
                href="/forms/{form.id}/edit"
                class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-bold transition-colors"
              >
                <Pencil size={14} />
                {m.form_list_edit_button()}
              </a>
              <button
                onclick={() => copyFormLink(form.id)}
                class="border-cn-border text-text-main hover:border-cn-yellow/40 inline-flex items-center gap-1.5 rounded-xl border-2 bg-(--cn-surface) px-3.5 py-2 text-xs font-bold transition-colors"
              >
                {#if copiedId === form.id}
                  <Check size={14} class="text-green-ok" />
                  {m.form_list_link_copied()}
                {:else}
                  <Link size={14} />
                  {m.form_list_share_button()}
                {/if}
              </button>
              <button
                onclick={() => (qrForm = form)}
                class="border-cn-border text-text-main hover:border-cn-yellow/40 inline-flex items-center gap-1.5 rounded-xl border-2 bg-(--cn-surface) px-3.5 py-2 text-xs font-bold transition-colors"
              >
                <QrCode size={14} />
                {m.qr_button()}
              </button>
              <button
                onclick={() => handleExport(form.id)}
                class="border-cn-border text-text-main hover:border-cn-yellow/40 inline-flex items-center gap-1.5 rounded-xl border-2 bg-(--cn-surface) px-3.5 py-2 text-xs font-bold transition-colors"
              >
                <Download size={14} />
                {m.form_list_export_button()}
              </button>
              <button
                onclick={() => toggleResponses(form.id)}
                class="border-cn-border text-text-main hover:border-cn-yellow/40 inline-flex items-center gap-1.5 rounded-xl border-2 bg-(--cn-surface) px-3.5 py-2 text-xs font-bold transition-colors"
              >
                <Users size={14} />
                {m.form_list_responses_button()}
                {#if expandedForms[form.id]}
                  <ChevronUp size={12} />
                {:else}
                  <ChevronDown size={12} />
                {/if}
              </button>
              <button
                onclick={() => handleDelete(form.id, form.title)}
                disabled={deletingId === form.id}
                class="border-red-err/30 bg-red-err/10 text-red-err hover:bg-red-err/20 inline-flex items-center justify-center rounded-xl border-2 p-2 transition-colors disabled:opacity-50"
                title={m.common_delete_button()}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          <!-- Responses accordion -->
          {#if expandedForms[form.id]}
            <div class="border-cn-border border-t-2 px-5 py-4">
              {#if submissionsData[form.id] === 'loading'}
                <div class="flex justify-center py-4">
                  <div
                    class="border-cn-yellow h-6 w-6 animate-spin rounded-full border-2 border-t-transparent"
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
                {@const subs = submissionsData[form.id] as Submission[]}
                <div class="overflow-x-auto">
                  <table class="w-full text-sm">
                    <thead>
                      <tr
                        class="text-text-muted border-cn-border border-b text-left text-xs font-bold tracking-wide uppercase"
                      >
                        <th class="pr-4 pb-2 whitespace-nowrap">{m.form_list_col_date()}</th>
                        <th class="pr-4 pb-2 whitespace-nowrap">{m.form_list_col_name()}</th>
                        <th class="pr-4 pb-2 whitespace-nowrap">{m.form_list_col_status()}</th>
                        <th class="pr-4 pb-2 whitespace-nowrap">{m.form_list_col_amount()}</th>
                        <th class="pb-2 whitespace-nowrap"></th>
                      </tr>
                    </thead>
                    <tbody class="divide-cn-border/50 divide-y">
                      {#each subs as sub (sub.id)}
                        <tr class="text-text-main">
                          <td class="text-text-muted py-2 pr-4 font-mono text-xs whitespace-nowrap"
                            >{formatDate(sub.createdAt)}</td
                          >
                          <td class="py-2 pr-4 whitespace-nowrap">
                            {#if sub.firstName || sub.lastName}
                              {[sub.firstName, sub.lastName].filter(Boolean).join(' ')}
                            {:else}
                              <span class="text-text-muted/60 font-mono text-xs"
                                >{getUserDisplayNameSync(sub.userId)}</span
                              >
                            {/if}
                          </td>
                          <td class="py-2 pr-4">
                            <span
                              class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold
                              {sub.paymentStatus === 'paid'
                                ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                                : sub.paymentStatus === 'free'
                                  ? 'bg-cn-border/40 text-text-muted'
                                  : sub.paymentStatus === 'pending' ||
                                      sub.paymentStatus === 'pending_cash'
                                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                                    : 'bg-red-err/20 text-red-err'}"
                            >
                              {statusLabel(sub.paymentStatus)}
                            </span>
                          </td>
                          <td class="py-2 pr-4 text-xs font-medium"
                            >{formatAmount(sub.totalPaid)}</td
                          >
                          <td class="py-2">
                            <button
                              onclick={() => void handleDeleteSubmission(form.id, sub)}
                              disabled={deletingSubmissionId === sub.id}
                              class="text-text-muted hover:bg-red-err/10 inline-flex items-center justify-center rounded-lg p-1.5 transition-colors hover:text-red-600 disabled:opacity-50"
                              title={m.form_list_delete_response_title()}
                            >
                              <X size={13} />
                            </button>
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if qrForm}
  <QrCodeModal
    open
    url={publicAppUrl(formPath(qrForm.id))}
    label={qrForm.title}
    owner={qrForm.associationName}
    intro={m.form_qr_intro()}
    onClose={() => (qrForm = null)}
  />
{/if}
