<script lang="ts">
  import { settings } from '$lib/stores/settingsStore.svelte';
  import { themeStore } from '$lib/stores/themeStore.svelte';
  import { Settings, Volume2, VolumeX, Vibrate, VibrateOff, Sun, Moon, Monitor } from '@lucide/svelte';

  interface Props {
    /** Whether the device is touch-capable (shows the vibration toggle). */
    isTouchDevice: boolean;
  }

  let { isTouchDevice }: Props = $props();
</script>

<div
  class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200"
  style="animation-fill-mode: backwards;"
>
  <div class="flex items-center gap-3 mb-6">
    <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
      <Settings size={22} strokeWidth={2.5} />
    </div>
    <h2 class="text-lg font-extrabold text-text-main">Préférences</h2>
  </div>

  <div class="space-y-5">
    <div class="flex items-center justify-between gap-4">
      <div class="flex items-center gap-3.5">
        <div class="p-2.5 rounded-xl bg-black/5 dark:bg-black/40 text-text-muted">
          {#if settings.soundsEnabled}
            <Volume2 size={20} strokeWidth={2.5} />
          {:else}
            <VolumeX size={20} strokeWidth={2.5} />
          {/if}
        </div>
        <div>
          <p class="text-sm font-bold text-text-main">Bruitages</p>
          <p class="text-xs font-medium text-text-muted mt-0.5">
            Sons de réception, envoi et lecture des messages
          </p>
        </div>
      </div>

      <button
        role="switch"
        aria-checked={settings.soundsEnabled}
        aria-label="Activer ou désactiver les bruitages"
        onclick={() => settings.setSoundsEnabled(!settings.soundsEnabled)}
        class="relative shrink-0 w-12 h-6 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow focus-visible:ring-offset-2
          {settings.soundsEnabled ? 'bg-cn-yellow' : 'bg-black/20 dark:bg-white/15'}"
      >
        <span
          class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-200
            {settings.soundsEnabled ? 'translate-x-6' : 'translate-x-0'}"
        ></span>
      </button>
    </div>

    {#if isTouchDevice}
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3.5">
          <div class="p-2.5 rounded-xl bg-black/5 dark:bg-black/40 text-text-muted">
            {#if settings.vibrationsEnabled}
              <Vibrate size={20} strokeWidth={2.5} />
            {:else}
              <VibrateOff size={20} strokeWidth={2.5} />
            {/if}
          </div>
          <div>
            <p class="text-sm font-bold text-text-main">Vibrations</p>
            <p class="text-xs font-medium text-text-muted mt-0.5">
              Retour haptique sur les actions (réactions, réponses…)
            </p>
          </div>
        </div>

        <button
          role="switch"
          aria-checked={settings.vibrationsEnabled}
          aria-label="Activer ou désactiver les vibrations"
          onclick={() => settings.setVibrationsEnabled(!settings.vibrationsEnabled)}
          class="relative shrink-0 w-12 h-6 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow focus-visible:ring-offset-2
            {settings.vibrationsEnabled ? 'bg-cn-yellow' : 'bg-black/20 dark:bg-white/15'}"
        >
          <span
            class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-200
              {settings.vibrationsEnabled ? 'translate-x-6' : 'translate-x-0'}"
          ></span>
        </button>
      </div>
    {/if}

    <div class="flex items-center justify-between gap-4">
      <div class="flex items-center gap-3.5">
        <div class="p-2.5 rounded-xl bg-black/5 dark:bg-black/40 text-text-muted">
          {#if themeStore.preference === 'light'}
            <Sun size={20} strokeWidth={2.5} />
          {:else if themeStore.preference === 'dark'}
            <Moon size={20} strokeWidth={2.5} />
          {:else}
            <Monitor size={20} strokeWidth={2.5} />
          {/if}
        </div>
        <div>
          <p class="text-sm font-bold text-text-main">Thème</p>
          <p class="text-xs font-medium text-text-muted mt-0.5">Apparence de l'interface</p>
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label="Thème de l'interface"
        class="flex shrink-0 items-center gap-1 rounded-xl bg-black/5 p-1 dark:bg-white/10"
      >
        {#each [{ value: 'system', label: 'Système', Icon: Monitor }, { value: 'light', label: 'Clair', Icon: Sun }, { value: 'dark', label: 'Sombre', Icon: Moon }] as opt (opt.value)}
          {@const Icon = opt.Icon}
          <button
            type="button"
            role="radio"
            aria-checked={themeStore.preference === opt.value}
            aria-label={opt.label}
            title={opt.label}
            onclick={() => themeStore.setPreference(opt.value as 'system' | 'light' | 'dark')}
            class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-cn-yellow
              {themeStore.preference === opt.value
              ? 'bg-cn-yellow text-cn-ink shadow'
              : 'text-text-muted hover:text-text-main'}"
          >
            <Icon size={15} strokeWidth={2.5} />
            <span class="hidden sm:inline">{opt.label}</span>
          </button>
        {/each}
      </div>
    </div>
  </div>
</div>
