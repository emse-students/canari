<script lang="ts">
  /**
   * The switch used everywhere a setting is on or off.
   *
   * It exists because the forms admin hand-rolled the same fourteen-class markup once per setting
   * and the copies had drifted: the knob was `h-4 w-4` at `top-1 left-1` in one section and
   * `h-5 w-5` at `top-0.5 left-0.5` in the next two, so two switches on one screen were visibly
   * different sizes. One component, one geometry.
   */
  interface Props {
    /** Bindable on/off state. */
    checked: boolean;
    /** The setting's name, in bold beside the switch. */
    label: string;
    /** One line under the label explaining what turning it on does. */
    hint?: string;
    /** Whether the switch can be operated. */
    disabled?: boolean;
  }

  let { checked = $bindable(), label, hint, disabled = false }: Props = $props();
</script>

<label
  class="flex items-center gap-3 select-none {disabled
    ? 'cursor-not-allowed opacity-50'
    : 'cursor-pointer'}"
>
  <div class="relative shrink-0">
    <input type="checkbox" bind:checked {disabled} class="peer sr-only" />
    <div
      class="bg-cn-border peer-checked:bg-cn-yellow h-6 w-11 rounded-full transition-colors"
    ></div>
    <div
      class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5"
    ></div>
  </div>
  <div class="min-w-0">
    <span class="text-text-main text-sm font-semibold">{label}</span>
    {#if hint}
      <p class="text-text-muted text-xs">{hint}</p>
    {/if}
  </div>
</label>
