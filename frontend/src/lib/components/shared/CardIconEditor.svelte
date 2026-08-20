<script lang="ts">
  import type { Component } from 'svelte';
  import AssociationLogoCropper from '$lib/components/associations/AssociationLogoCropper.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    iconUrl: string | null;
    fallbackIcon: Component;
    onUpload: (file: File) => Promise<void>;
    onRemove: () => Promise<void>;
  }

  let { iconUrl, fallbackIcon: FallbackIcon, onUpload, onRemove }: Props = $props();

  let showCropper = $state(false);
  let busy = $state(false);
  let error = $state('');

  async function handleExported(blob: Blob) {
    busy = true;
    error = '';
    try {
      const file = new File([blob], 'icon.png', { type: 'image/png' });
      await onUpload(file);
      showCropper = false;
    } catch (e) {
      error = e instanceof Error ? e.message : m.card_icon_upload_error();
    } finally {
      busy = false;
    }
  }

  async function handleRemove() {
    if (
      !(await showConfirm(m.card_icon_remove_confirm(), {
        danger: true,
        confirmLabel: m.common_remove_label(),
      }))
    )
      return;
    busy = true;
    error = '';
    try {
      await onRemove();
    } catch (e) {
      error = e instanceof Error ? e.message : m.card_icon_upload_error();
    } finally {
      busy = false;
    }
  }
</script>

<div class="space-y-2">
  <div class="flex items-center gap-3">
    <div
      class="border-cn-border bg-cn-bg flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border"
    >
      {#if iconUrl}
        <img src={iconUrl} alt="" class="h-full w-full object-cover" />
      {:else}
        <FallbackIcon size={22} class="text-text-muted" />
      {/if}
    </div>
    <div class="flex flex-wrap gap-2">
      <button
        type="button"
        onclick={() => (showCropper = !showCropper)}
        disabled={busy}
        class="border-cn-border hover:bg-cn-bg rounded-xl border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
      >
        {showCropper ? m.card_icon_close_cropper() : m.card_icon_change_button()}
      </button>
      {#if iconUrl}
        <button
          type="button"
          onclick={handleRemove}
          disabled={busy}
          class="text-red-err hover:bg-red-err/10 rounded-xl px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {m.card_icon_remove_button()}
        </button>
      {/if}
    </div>
  </div>

  {#if error}
    <p class="text-red-err text-xs">{error}</p>
  {/if}

  {#if showCropper}
    <AssociationLogoCropper
      onExport={handleExported}
      onCancel={() => (showCropper = false)}
      outputFormat="png"
    />
  {/if}
</div>
