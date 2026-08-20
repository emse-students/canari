<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { handleOidcCallback, getOidcReturnTo } from '$lib/stores/auth';
  import { m } from '$lib/paraglide/messages';

  let error = $state('');
  let status = $state('');

  onMount(async () => {
    status = m.auth_callback_authenticating();
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const authError = params.get('error');

    if (authError) {
      error = m.auth_callback_denied({ reason: params.get('error_description') || authError });
      return;
    }

    if (!code || !state) {
      error = m.auth_callback_missing_params();
      return;
    }

    // Guard against double-load (Android WebView may navigate to the callback URL twice)
    const dedupKey = `oidc_code_${code}`;
    if (sessionStorage.getItem(dedupKey)) {
      console.warn('[callback] code already processed, ignoring duplicate load');
      return;
    }
    sessionStorage.setItem(dedupKey, '1');

    try {
      console.debug('[callback] starting handleOidcCallback, code length:', code.length);
      status = m.auth_callback_exchanging_code();
      const user = await handleOidcCallback(code, state);
      console.debug('[callback] handleOidcCallback resolved, user:', user?.id);

      status = m.auth_callback_success();
      const returnTo = await getOidcReturnTo();
      console.debug('[callback] goto ->', returnTo);
      await goto(returnTo, { replaceState: true });
      console.debug('[callback] goto resolved');
    } catch (e: unknown) {
      console.error('[callback] error:', e);
      error = e instanceof Error ? e.message : String(e);
    }
  });
</script>

<div class="flex min-h-dvh items-center justify-center px-4">
  <div
    class="border-cn-border w-full max-w-sm rounded-3xl border p-10 text-center shadow-lg"
    style="background: color-mix(in srgb, var(--cn-surface) 88%, transparent); backdrop-filter: blur(12px);"
  >
    {#if error}
      <div class="space-y-4">
        <div class="bg-red-err/20 mx-auto flex h-16 w-16 items-center justify-center rounded-full">
          <span class="text-red-err text-2xl">✗</span>
        </div>
        <h2 class="text-text-main text-lg font-bold">{m.auth_callback_error_title()}</h2>
        <p class="text-red-err text-sm">{error}</p>
        <button
          onclick={() => goto('/login', { replaceState: true })}
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover mt-4 rounded-2xl px-6 py-3 font-bold transition-all"
        >
          {m.auth_callback_retry()}
        </button>
      </div>
    {:else}
      <div class="space-y-4">
        <div
          class="bg-cn-yellow/20 mx-auto flex h-16 w-16 items-center justify-center rounded-full"
        >
          <span
            class="border-cn-dark/20 border-t-cn-dark inline-block h-6 w-6 animate-spin rounded-full border-3"
          ></span>
        </div>
        <p class="text-text-muted text-sm font-medium">{status}</p>
      </div>
    {/if}
  </div>
</div>
