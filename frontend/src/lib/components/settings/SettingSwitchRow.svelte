<script lang="ts">
  /**
   * One settings row with an on/off switch: the optional icon tile and the label and hint on the
   * left, the switch on the RIGHT - the geometry every Preferences and Notifications row shares. It
   * replaces `ui/Toggle` in those sections, whose switch sits on the left and carries no tile (#3329
   * rows drew out of line with their neighbours). The icon is optional: Notifications rows have none.
   */
  import type { Component } from 'svelte';

  interface Props {
    /** The setting's name, in bold. */
    label: string;
    /** One line under the label explaining what turning it on does. */
    hint?: string;
    /** The icon tile on the left; omit it where the neighbouring rows draw none. */
    icon?: Component<{ size?: number; strokeWidth?: number }>;
    /** What the switch draws. */
    checked: boolean;
    /** Names the switch for a screen reader; defaults to the label. */
    ariaLabel?: string;
    /** A write is in flight: the switch is `aria-busy` and a click does nothing (focus is kept). */
    busy?: boolean;
    /** Called with the state the switch is asked to take. */
    onchange: (next: boolean) => void;
  }

  let { label, hint, icon, checked, ariaLabel, busy = false, onchange }: Props = $props();
  const Icon = $derived(icon);
</script>

<div class="flex items-center justify-between gap-4">
  <div class="flex items-center gap-3.5">
    {#if Icon}
      <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
        <Icon size={20} strokeWidth={2.5} />
      </div>
    {/if}
    <div>
      <p class="text-text-main text-sm font-bold">{label}</p>
      {#if hint}
        <p class="text-text-muted mt-0.5 text-xs font-medium">{hint}</p>
      {/if}
    </div>
  </div>

  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={ariaLabel ?? label}
    aria-busy={busy}
    aria-disabled={busy || undefined}
    onclick={() => {
      if (!busy) onchange(!checked);
    }}
    class="focus-visible:ring-accent-icon relative h-6 w-12 shrink-0 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-offset-2
 {checked ? 'bg-accent' : 'bg-black/20 dark:bg-white/15'} {busy ? 'cursor-wait opacity-60' : ''}"
  >
    <span
      class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200
 {checked ? 'translate-x-6' : 'translate-x-0'}"
    ></span>
  </button>
</div>
