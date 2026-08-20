<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { CircleCheck, CircleX, Loader } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  const sessionId = $derived(page.url.searchParams.get('session_id'));

  let status = $state<'loading' | 'confirmed' | 'error'>('loading');
  let formId = $state<string | null>(null);

  onMount(async () => {
    if (!sessionId) {
      status = 'error';
      return;
    }
    try {
      const coreUrl = (import.meta as any).env?.VITE_CORE_URL?.trim() || '';
      const res = await fetch(`${coreUrl}/api/payments/verify-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      if (data.ok) {
        formId = data.formId ?? null;
        status = 'confirmed';
      } else {
        status = 'error';
      }
    } catch {
      status = 'error';
    }
  });
</script>

<svelte:head>
  <title>{m.form_success_title()}</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center px-4">
  <div class="w-full max-w-md space-y-6 text-center">
    {#if status === 'loading'}
      <div class="flex justify-center">
        <div class="bg-cn-border/30 animate-pulse rounded-full p-4">
          <Loader size={48} class="text-text-muted animate-spin" />
        </div>
      </div>
      <p class="text-text-muted">{m.form_success_verifying()}</p>
    {:else if status === 'confirmed'}
      <div class="flex justify-center">
        <div class="bg-green-ok/15 rounded-full p-4">
          <CircleCheck size={48} class="text-green-ok" />
        </div>
      </div>
      <div>
        <h1 class="text-text-main text-2xl font-extrabold tracking-tight">
          {m.form_success_confirmed_heading()}
        </h1>
        <p class="text-text-muted mt-2">
          {m.form_success_confirmed_desc()}
        </p>
      </div>
      <a
        href={formId ? `/forms/${formId}` : '/forms'}
        class="bg-cn-yellow text-cn-dark hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-bold shadow-sm transition-all"
      >
        {m.form_success_back_to_form()}
      </a>
    {:else}
      <div class="flex justify-center">
        <div class="bg-red-err/20 rounded-full p-4">
          <CircleX size={48} class="text-red-500" />
        </div>
      </div>
      <div>
        <h1 class="text-text-main text-2xl font-extrabold tracking-tight">
          {m.form_success_not_found_heading()}
        </h1>
        <p class="text-text-muted mt-2">
          {m.form_success_not_found_desc()}
        </p>
      </div>
      <a
        href="/forms"
        class="bg-cn-border/40 text-text-main hover:bg-cn-border/60 inline-flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-bold transition-all"
      >
        {m.form_success_back_to_forms()}
      </a>
    {/if}
  </div>
</div>
