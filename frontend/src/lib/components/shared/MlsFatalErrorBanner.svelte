<script lang="ts">
  import { globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import { m } from '$lib/paraglide/messages';
  import Banner from './Banner.svelte';

  const error = $derived(globalSession.mlsFatalError);

  const config = $derived(
    error === 'oom'
      ? {
          variant: 'danger' as const,
          text: m.mls_error_oom_text(),
          action: m.mls_error_reload_action(),
          onAction: () => window.location.reload(),
          dismissible: false,
        }
      : error === 'private_mode'
        ? {
            variant: 'info' as const,
            text: m.mls_error_private_mode_text(),
            action: m.mls_error_dismiss_action(),
            onAction: () => globalSession.clearMlsFatalError(),
            dismissible: true,
          }
        : error === 'keystore_lost'
          ? {
              variant: 'notice' as const,
              text: m.mls_error_keystore_lost_text(),
              action: m.mls_error_dismiss_action(),
              onAction: () => globalSession.clearMlsFatalError(),
              dismissible: true,
            }
          : null
  );
</script>

{#if error && config}
  <!-- `alert`, not `status`: this one is allowed to interrupt what a screen reader is saying,
       because the MLS stack is down and nothing the user types will be sent. -->
  <Banner variant={config.variant} tone="alert">
    <span class="flex-1">{config.text}</span>

    {#snippet action()}
      <button
        type="button"
        class="shrink-0 rounded-md bg-white/20 px-3 py-1 text-xs font-semibold transition-colors hover:bg-white/30"
        onclick={config.onAction}
      >
        {config.action}
      </button>
    {/snippet}
  </Banner>
{/if}
