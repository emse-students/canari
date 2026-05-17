<script lang="ts">
  import { onMount } from 'svelte';
  import { exportSubmissions, getForms, type Form } from '$lib/forms/api';
  import { Plus, Download, Copy, FileText } from '@lucide/svelte';

  let forms = $state<Form[]>([]);
  let loading = $state(true);

  onMount(async () => {
    try {
      forms = await getForms();
    } catch {
      // unauthenticated or API unavailable — leave empty
    } finally {
      loading = false;
    }
  });

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
      alert('Export failed');
    }
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
          class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] p-5 flex flex-col sm:flex-row sm:items-center gap-3 hover:border-cn-yellow/40 transition-colors"
        >
          <div class="flex-1 min-w-0">
            <h2 class="font-bold text-text-main truncate">{form.title}</h2>
            {#if form.description}
              <p class="text-sm text-text-muted mt-0.5 truncate">{form.description}</p>
            {/if}
            <p class="text-xs text-text-muted/60 font-mono mt-1.5 truncate">{form.id}</p>
          </div>
          <div class="flex gap-2 flex-shrink-0">
            <button
              onclick={() => handleExport(form.id)}
              class="inline-flex items-center gap-1.5 rounded-xl border-2 border-cn-border bg-[var(--cn-surface)] px-3.5 py-2 text-xs font-bold text-text-main hover:border-cn-yellow/40 transition-colors"
            >
              <Download size={14} />
              Exporter
            </button>
            <button
              onclick={() => navigator.clipboard.writeText(form.id)}
              class="inline-flex items-center gap-1.5 rounded-xl border-2 border-cn-border bg-[var(--cn-surface)] px-3.5 py-2 text-xs font-bold text-text-main hover:border-cn-yellow/40 transition-colors"
            >
              <Copy size={14} />
              Copier ID
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
