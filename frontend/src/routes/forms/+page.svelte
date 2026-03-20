<script lang="ts">
  import { onMount } from 'svelte';
  import { getForms, exportSubmissions, type Form } from '$lib/forms/api';

  let forms = $state<Form[]>([]);
  let userId = 'user-123'; // Hardcoded for now, should come from auth store

  onMount(async () => {
    try {
      forms = await getForms(userId);
    } catch (e) {
      console.error(e);
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

<div class="p-6 max-w-4xl mx-auto">
  <div class="flex justify-between items-center mb-6">
    <h1 class="text-2xl font-bold">My Forms</h1>
    <a href="/forms/create" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
      Create New Form
    </a>
  </div>

  {#if forms.length === 0}
    <p>No forms found.</p>
  {:else}
    <div class="grid gap-4">
      {#each forms as form (form._id)}
        <div
          class="border p-4 rounded shadow bg-white dark:bg-gray-800 flex justify-between items-center"
        >
          <div>
            <h2 class="font-bold text-lg">{form.title}</h2>
            <p class="text-sm text-gray-500">{form.description || 'No description'}</p>
            <p class="text-xs text-gray-400">ID: {form._id}</p>
          </div>
          <div class="flex gap-2">
            <button
              onclick={() => handleExport(form._id)}
              class="px-3 py-1 bg-green-600 text-white rounded text-sm"
            >
              Export Submissions
            </button>
            <button
              onclick={() => navigator.clipboard.writeText(form._id)}
              class="px-3 py-1 bg-gray-600 text-white rounded text-sm"
            >
              Copy ID
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
