<script lang="ts">
  import { CloudOff, Loader2, ServerCrash, Wrench } from '@lucide/svelte';
  import { page } from '$app/state';
  import {
    bootSessionBlocks,
    bootSessionPhase,
    bootMaintenanceMessage,
    bootUnreachableCause,
    noteSessionKnownElsewhere,
    retryBootSession,
  } from '$lib/stores/bootSession.svelte';
  import { sessionAnsweredFor } from '$lib/stores/sessionAnswer.svelte';
  import { globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import ModalOverlay from '$lib/components/shared/ModalOverlay.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * What the screen says while the session question is open (`bootSession`): a boot state, then -
   * only if the question got no VERDICT - an explicit statement of WHO failed, from the cause the store
   * typed (`bootUnreachableCause`): this network (nobody answered, or the edge refused the path), the
   * server (a 5xx, 408, 429), or a maintenance (core-service's 503 `MAINTENANCE`, worded like the
   * platform gate). It covers the shell; the layout does not mount the page underneath and makes the
   * shell `inert`, so Tab cannot reach what the screen hides.
   *
   * ONLY THE ONE-LINE STATE IS A LIVE REGION: a heading and a button inside `aria-live` are
   * re-announced as a block. Focus moves to Retry when the network cannot be reached, because a
   * keyboard or screen-reader user has nothing else to reach.
   */
  const blocked = $derived(bootSessionBlocks(page.url.pathname));
  const unreachable = $derived(bootSessionPhase() === 'unreachable');
  const copy = $derived.by(() => {
    switch (bootUnreachableCause()) {
      case 'maintenance':
        return {
          icon: Wrench,
          title: m.platform_gate_maintenance_title(),
          // The operator's own text when one was set, as the platform gate shows it.
          hint: bootMaintenanceMessage() || m.platform_gate_maintenance_default_msg(),
        };
      case 'server':
        return {
          icon: ServerCrash,
          title: m.boot_server_error_title(),
          hint: m.boot_server_error_hint(),
        };
      case 'network':
        return {
          icon: CloudOff,
          title: m.boot_unreachable_title(),
          hint: m.boot_unreachable_hint(),
        };
    }
  });
  let retryButton = $state<HTMLButtonElement | null>(null);

  // A session known by another road (another caller's refresh answered, the unlock completed) ends
  // the question: the screen must not outlive the fact it was waiting for.
  $effect(() => {
    if (bootSessionPhase() === 'settled') return;
    if (sessionAnsweredFor() || globalSession.isLoggedIn) noteSessionKnownElsewhere();
  });

  $effect(() => {
    if (blocked && unreachable) retryButton?.focus();
  });
</script>

<!--
  THE ONE OVERLAY EVERY MODAL USES (`ModalOverlay`): portalled to the body, so it sits OUTSIDE the
  `inert` shell, on the `critical` rung, with the safe area, and registered with `coversScreen` (the
  iOS native tab bar hides under it). It cannot be dismissed: Escape and the system Back are no-ops
  (`dismissible={false}`, `onClose` does nothing), because nothing sits behind it to go back to. The
  panel is made opaque and full-screen so the shell never reads through it.
-->
<ModalOverlay
  open={blocked}
  onClose={() => {}}
  dismissible={false}
  gate="BootGate"
  scrim={false}
  label={unreachable ? copy.title : m.boot_connecting()}
  panelClass="bg-cn-bg text-text-main fixed inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center"
>
  <div class="contents" data-testid="boot-gate">
    {#if unreachable}
      <copy.icon size={40} class="text-text-muted" aria-hidden="true" />
      <p class="text-lg font-bold" role="status" aria-live="polite">
        {copy.title}
      </p>
      <p class="text-text-muted max-w-sm text-sm">{copy.hint}</p>
      <button
        bind:this={retryButton}
        type="button"
        class="bg-accent text-on-accent hover:bg-accent-hover rounded-lg px-4 py-2 text-sm font-bold"
        onclick={retryBootSession}
      >
        {m.boot_unreachable_retry()}
      </button>
    {:else}
      <Loader2 size={32} class="text-text-muted animate-spin" aria-hidden="true" />
      <p class="text-text-muted text-sm" role="status" aria-live="polite">
        {m.boot_connecting()}
      </p>
    {/if}
  </div>
</ModalOverlay>
