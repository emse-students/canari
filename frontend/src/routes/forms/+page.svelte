<script lang="ts">
  import { onMount } from 'svelte';
  import { exportSubmissions, getForms, type Form } from '$lib/forms/api';

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

<div class="px-4 py-6 sm:px-6 max-w-4xl mx-auto">
  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
    <h1 class="text-2xl font-extrabold text-text-main tracking-tight">Mes formulaires</h1>
    <a
      href="/forms/create"
      class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors self-start sm:self-auto"
    >
      + Nouveau formulaire
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
      class="text-center py-16 px-8 rounded-3xl border-2 border-dashed border-cn-border bg-white/50"
    >
      <div class="text-5xl mb-3">📋</div>
      <p class="text-text-muted font-medium">Aucun formulaire pour l'instant.</p>
      <a href="/forms/create" class="mt-4 inline-block text-sm font-semibold text-cn-dark underline"
        >Créer le premier</a
      >
    </div>
  {:else}
    <div class="grid gap-3">
      {#each forms as form (form._id)}
        <div
          class="rounded-2xl border border-cn-border bg-white/80 p-4 flex flex-col sm:flex-row sm:items-center gap-3"
        >
          <div class="flex-1 min-w-0">
            <h2 class="font-bold text-text-main truncate">{form.title}</h2>
            {#if form.description}
              <p class="text-sm text-text-muted mt-0.5 truncate">{form.description}</p>
            {/if}
            <p class="text-xs text-text-muted/70 font-mono mt-1 truncate">ID: {form._id}</p>
          </div>
          <div class="flex gap-2 flex-shrink-0">
            <button
              onclick={() => handleExport(form._id)}
              class="rounded-lg border border-cn-border bg-white px-3 py-1.5 text-xs font-semibold text-text-main hover:bg-cn-surface transition-colors"
            >
              Exporter
            </button>
            <button
              onclick={() => navigator.clipboard.writeText(form._id)}
              class="rounded-lg border border-cn-border bg-white px-3 py-1.5 text-xs font-semibold text-text-main hover:bg-cn-surface transition-colors"
            >
              Copier ID
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
