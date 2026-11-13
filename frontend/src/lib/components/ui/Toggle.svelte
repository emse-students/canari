<script lang="ts">
  /**
   * The switch used everywhere a setting is on or off.
   *
   * It exists because the forms admin hand-rolled the same fourteen-class markup once per setting
   * and the copies had drifted: the knob was `h-4 w-4` at `top-1 left-1` in one section and
   * `h-5 w-5` at `top-0.5 left-0.5` in the next two, so two switches on one screen were visibly
   * different sizes. One component, one geometry.
   */
  import type { Component } from 'svelte';

  interface Props {
    /** Bindable on/off state. */
    checked: boolean;
    /** The setting's name, in bold beside the switch. */
    label: string;
    /** One line under the label explaining what turning it on does. */
    hint?: string;
    /** Whether the switch can be operated. */
    disabled?: boolean;
    /**
     * A write of this setting is in flight: the switch is `aria-busy` and `aria-disabled`, and a
     * click does nothing - never `disabled`, which would drop focus out of a dialog's focus trap.
     */
    busy?: boolean;
    /** Called with the new state after the user flips the switch (for a write that is not a bind). */
    onchange?: (checked: boolean) => void;
    /**
     * `row`: the settings-row layout - optional icon tile and the text on the left, the switch on
     * the RIGHT, as every Preferences and Notifications row draws it. Default `inline`: switch first.
     */
    layout?: 'inline' | 'row';
    /** The icon tile of a `row` layout; omit it where the neighbouring rows draw none. */
    icon?: Component<{ size?: number; strokeWidth?: number }>;
  }

  let {
    checked = $bindable(),
    label,
    hint,
    disabled = false,
    busy = false,
    onchange,
    layout = 'inline',
    icon,
  }: Props = $props();
  const Icon = $derived(icon);
</script>

<label
  class="flex items-center select-none {layout === 'row'
    ? 'justify-between gap-4'
    : 'gap-3'} {disabled
    ? 'cursor-not-allowed opacity-50'
    : busy
      ? 'cursor-wait opacity-60'
      : 'cursor-pointer'}"
>
  {#if layout === 'row'}
    <div class="flex min-w-0 items-center gap-3.5">
      {#if Icon}
        <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
          <Icon size={20} strokeWidth={2.5} />
        </div>
      {/if}
      <div class="min-w-0">
        <p class="text-text-main text-sm font-bold">{label}</p>
        {#if hint}
          <p class="text-text-muted mt-0.5 text-xs font-medium">{hint}</p>
        {/if}
      </div>
    </div>
  {/if}
  <div class="relative shrink-0">
    <input
      type="checkbox"
      bind:checked
      {disabled}
      aria-busy={busy}
      aria-disabled={busy || undefined}
      onclick={(e) => {
        // A click while the last write is still saving is not a change: the box stays as drawn.
        if (busy) e.preventDefault();
      }}
      onchange={() => onchange?.(checked)}
      class="peer sr-only"
    />
    <div class="bg-cn-border peer-checked:bg-accent h-6 w-11 rounded-full transition-colors"></div>
    <div
      class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5"
    ></div>
  </div>
  {#if layout !== 'row'}
    <div class="min-w-0">
      <span class="text-text-main text-sm font-semibold">{label}</span>
      {#if hint}
        <p class="text-text-muted text-xs">{hint}</p>
      {/if}
    </div>
  {/if}
</label>
