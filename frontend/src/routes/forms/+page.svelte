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
    Trash2,
    ChevronDown,
    ChevronUp,
    Users,
    X,
  } from '@lucide/svelte';
  import { copyPublicShareLink } from '$lib/utils/copyShareLink';

  let copiedId = $state<string | null>(null);

  function copyFormLink(id: string) {
    void copyPublicShareLink(`/forms/${id}`);
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
      // unauthenticated or API unavailable - leave empty
    } finally {
      loading = false;
    }
  });

  async function handleDelete(id: string, title: string) {
    if (!await showConfirm(`Supprimer le formulaire « ${title} » ? Cette action est irréversible.`, { danger: true, confirmLabel: 'Supprimer' })) return;
    deletingId = id;
    try {
      await deleteForm(id);
      forms = forms.filter((f) => f.id !== id);
    } catch {
      showToast('Erreur lors de la suppression');
    } finally {
      deletingId = null;
    }
  }

  async function handleExport(id: string) {
    try {
      const blob = await exportSubmissions(id);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `submissions_${id}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      showToast("Échec de l'export");
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
    const name = [sub.firstName, sub.lastName].filter(Boolean).join(' ') || sub.userId.slice(0, 8);
    if (!await showConfirm(`Supprimer la réponse de ${name} ? Cette action est irréversible.`, { danger: true, confirmLabel: 'Supprimer' })) return;
    deletingSubmissionId = sub.id;
    try {
      await deleteSubmission(sub.id);
      const current = submissionsData[formId];
      if (Array.isArray(current)) {
        submissionsData = { ...submissionsData, [formId]: current.filter((s) => s.id !== sub.id) };
      }
    } catch {
      showToast('Erreur lors de la suppression');
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
    return (
      (
        {
          free: 'Gratuit',
          pending: 'En attente',
          pending_cash: 'Espèces en attente',
          paid: 'Payé',
          cancelled: 'Annulé',
          expired: 'Expiré',
        } as Record<string, string>
      )[s] ?? s
    );
  }

  /** Formats cents as a currency string, or "–" for zero. */
  function formatAmount(cents: number): string {
    if (!cents) return '–';
    return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'eur' });
  }
</script>

<div class="px-4 py-6 sm:px-6 max-w-3xl mx-auto">
  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-8">
    <div>
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight">Mes formulaires</h1>
      <p class="text-sm text-text-muted mt-0.5">
        {forms.length} formulaire{forms.length !== 1 ? 's' : ''}
      </p>
    </div>
    <a
      href="/forms/create"
      class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors self-start sm:self-auto"
    >
      <Plus size={16} />
      Nouveau formulaire
    </a>
  </div>

  {#if loading}
    <div class="flex justify-center py-16">
      <div
        class="w-10 h-10 border-4 border-cn-yellow border-t-transparent rounded-full animate-spin"
      ></div>
    </div>
  {:else if forms.length === 0}
    <div
      class="text-center py-16 px-8 rounded-2xl border-2 border-dashed border-cn-border bg-[var(--cn-surface)]"
    >
      <div
        class="w-14 h-14 mx-auto mb-4 rounded-2xl bg-cn-yellow/15 flex items-center justify-center text-cn-dark"
      >
        <FileText size={28} />
      </div>
      <p class="text-text-muted font-medium mb-1">Aucun formulaire pour l'instant</p>
      <p class="text-sm text-text-muted/60 mb-4">
        Créez votre premier formulaire pour commencer à collecter des réponses.
      </p>
      <a
        href="/forms/create"
        class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors"
      >
        <Plus size={16} />
        Créer un formulaire
      </a>
    </div>
  {:else}
    <div class="space-y-3">
      {#each forms as form (form.id)}
        <div
          class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] transition-colors {expandedForms[
            form.id
          ]
            ? 'border-cn-yellow/40'
            : 'hover:border-cn-yellow/40'}"
        >
          <!-- Card header -->
          <div class="p-5 flex flex-col sm:flex-row sm:items-center gap-3">
            <div class="flex-1 min-w-0">
              <h2 class="font-bold text-text-main truncate">{form.title}</h2>
              {#if form.description}
                <p class="text-sm text-text-muted mt-0.5 truncate">{form.description}</p>
              {/if}
              <p class="text-xs text-text-muted/60 font-mono mt-1.5 truncate">{form.id}</p>
            </div>
            <div class="flex flex-wrap gap-2 flex-shrink-0">
              <a
                href="/forms/{form.id}/edit"
                class="inline-flex items-center gap-1.5 rounded-xl bg-cn-yellow px-3.5 py-2 text-xs font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors"
              >
                <Pencil size={14} />
                Modifier
              </a>
              <button
                onclick={() => copyFormLink(form.id)}
                class="inline-flex items-center gap-1.5 rounded-xl border-2 border-cn-border bg-[var(--cn-surface)] px-3.5 py-2 text-xs font-bold text-text-main hover:border-cn-yellow/40 transition-colors"
              >
                {#if copiedId === form.id}
                  <Check size={14} class="text-green-600" />
                  Lien copié
                {:else}
                  <Link size={14} />
                  Partager
                {/if}
              </button>
              <button
                onclick={() => handleExport(form.id)}
                class="inline-flex items-center gap-1.5 rounded-xl border-2 border-cn-border bg-[var(--cn-surface)] px-3.5 py-2 text-xs font-bold text-text-main hover:border-cn-yellow/40 transition-colors"
              >
                <Download size={14} />
                Exporter
              </button>
              <button
                onclick={() => toggleResponses(form.id)}
                class="inline-flex items-center gap-1.5 rounded-xl border-2 border-cn-border bg-[var(--cn-surface)] px-3.5 py-2 text-xs font-bold text-text-main hover:border-cn-yellow/40 transition-colors"
              >
                <Users size={14} />
                Réponses
                {#if expandedForms[form.id]}
                  <ChevronUp size={12} />
                {:else}
                  <ChevronDown size={12} />
                {/if}
              </button>
              <button
                onclick={() => handleDelete(form.id, form.title)}
                disabled={deletingId === form.id}
                class="inline-flex items-center justify-center rounded-xl border-2 border-red-200 bg-red-50/80 p-2 text-red-600 hover:bg-red-100 transition-colors disabled:opacity-50"
                title="Supprimer"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          <!-- Responses accordion -->
          {#if expandedForms[form.id]}
            <div class="border-t-2 border-cn-border px-5 py-4">
              {#if submissionsData[form.id] === 'loading'}
                <div class="flex justify-center py-4">
                  <div
                    class="w-6 h-6 border-2 border-cn-yellow border-t-transparent rounded-full animate-spin"
                  ></div>
                </div>
              {:else if submissionsData[form.id] === 'error'}
                <p class="text-sm text-red-600 text-center py-2">
                  Impossible de charger les réponses.
                </p>
              {:else if Array.isArray(submissionsData[form.id]) && (submissionsData[form.id] as Submission[]).length === 0}
                <p class="text-sm text-text-muted text-center py-2">
                  Aucune réponse pour l'instant.
                </p>
              {:else if Array.isArray(submissionsData[form.id])}
                {@const subs = submissionsData[form.id] as Submission[]}
                <div class="overflow-x-auto">
                  <table class="w-full text-sm">
                    <thead>
                      <tr
                        class="text-left text-xs font-bold text-text-muted uppercase tracking-wide border-b border-cn-border"
                      >
                        <th class="pb-2 pr-4 whitespace-nowrap">Date & heure</th>
                        <th class="pb-2 pr-4 whitespace-nowrap">Nom</th>
                        <th class="pb-2 pr-4 whitespace-nowrap">Statut</th>
                        <th class="pb-2 pr-4 whitespace-nowrap">Montant</th>
                        <th class="pb-2 whitespace-nowrap"></th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-cn-border/50">
                      {#each subs as sub (sub.id)}
                        <tr class="text-text-main">
                          <td class="py-2 pr-4 text-xs font-mono text-text-muted whitespace-nowrap"
                            >{formatDate(sub.createdAt)}</td
                          >
                          <td class="py-2 pr-4 whitespace-nowrap">
                            {#if sub.firstName || sub.lastName}
                              {[sub.firstName, sub.lastName].filter(Boolean).join(' ')}
                            {:else}
                              <span class="text-text-muted/60 text-xs font-mono"
                                >{sub.userId.slice(0, 8)}…</span
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
                                    : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'}"
                            >
                              {statusLabel(sub.paymentStatus)}
                            </span>
                          </td>
                          <td class="py-2 pr-4 text-xs font-medium">{formatAmount(sub.totalPaid)}</td>
                          <td class="py-2">
                            <button
                              onclick={() => void handleDeleteSubmission(form.id, sub)}
                              disabled={deletingSubmissionId === sub.id}
                              class="inline-flex items-center justify-center rounded-lg p-1.5 text-text-muted hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                              title="Supprimer cette réponse"
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
