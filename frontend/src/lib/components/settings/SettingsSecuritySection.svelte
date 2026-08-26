<script lang="ts">
  import {
    Shield,
    KeyRound,
    Monitor,
    CircleCheck,
    FingerprintPattern,
    LogIn,
  } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { globalSession as session, appendLog } from '$lib/stores/globalChatSingleton.svelte';
  import { createPausableInterval } from '$lib/utils/backgroundPausableInterval';
  import ChangePinModal from '$lib/components/auth/ChangePinModal.svelte';
  import DeviceManagementPanel from '$lib/components/chat/DeviceManagementPanel.svelte';
  import { type PinOperationProgress } from '$lib/utils/chat/pinChange';
  import { BiometricService } from '$lib/services/biometric';
  import {
    isDeviceKeyPersistenceEnabled,
    setDeviceKeyPersistence,
  } from '$lib/utils/deviceKeyVault';
  import { isTauriRuntime } from '$lib/utils/openExternal';
  import { showToast } from '$lib/stores/toast.svelte';
  import { m } from '$lib/paraglide/messages';

  // Biometric unlock toggle (mobile with biometric hardware only).
  let biometricAvailable = $state(false);
  let biometricEnabled = $state(false);
  let biometricBusy = $state(false);

  // "Stay signed in" toggle (browser only): persists the device key vault across browser restarts.
  const showStaySignedIn = !isTauriRuntime();
  let staySignedIn = $state(false);

  onMount(async () => {
    staySignedIn = isDeviceKeyPersistenceEnabled();
    biometricAvailable = await BiometricService.isAvailable().catch(() => false);
    if (biometricAvailable) {
      biometricEnabled = await BiometricService.isConfigured().catch(() => false);
    }
  });

  /**
   * Toggles hardware biometric unlock. Enabling hands the keystore key over to the biometric
   * prompt; disabling re-seeds the session device key vault. If the device has no fingerprint
   * enrolled, enrolment silently no-ops and we surface a hint toast.
   */
  async function toggleBiometric() {
    if (biometricBusy) return;
    biometricBusy = true;
    try {
      if (biometricEnabled) {
        await session.disableBiometric();
        biometricEnabled = false;
      } else {
        await session.enrollBiometric();
        biometricEnabled = await BiometricService.isConfigured().catch(() => false);
        if (!biometricEnabled) showToast(m.auth_biometric_no_fingerprint_android(), 'info');
      }
    } catch (e) {
      appendLog(`[BIOMETRIC] Toggle failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      biometricBusy = false;
    }
  }

  /** Toggles "stay signed in": migrates the device key vault to localStorage (on) or sessionStorage (off). */
  async function toggleStaySignedIn() {
    const next = !staySignedIn;
    await setDeviceKeyPersistence(next, session.deviceKeyB64 || null);
    staySignedIn = next;
  }

  // PIN change + device management. Both flows own their state here so the section is drop-in.
  let showDevicePanel = $state(false);
  let showChangePinModal = $state(false);
  let changePinError = $state('');
  let changePinLoading = $state(false);
  let changePinProgress = $state<PinOperationProgress | null>(null);
  let changePinSuccess = $state('');
  let deviceCount = $state(0);

  // Device-count badge for the device management panel (polls the user's registered devices).
  $effect(() => {
    if (!session.isLoggedIn || !session.myDeviceId) return;
    const userId = session.userId;
    let cancelled = false;
    async function poll() {
      if (cancelled) return;
      try {
        const devices = await session.ensureMls().fetchUserDevices(userId);
        if (!cancelled) {
          deviceCount = devices.length;
        }
      } catch {
        // MLS not ready yet
      }
    }
    const cleanup = createPausableInterval(() => void poll(), 30_000);
    return () => {
      cancelled = true;
      cleanup();
    };
  });

  // Auto-clear the PIN-change success banner.
  $effect(() => {
    if (changePinSuccess) {
      const t = setTimeout(() => (changePinSuccess = ''), 6000);
      return () => clearTimeout(t);
    }
  });

  async function handleChangePin(currentPin: string, newPin: string) {
    changePinError = '';
    changePinLoading = true;
    changePinProgress = { percent: 0, stage: 'server' };
    try {
      await session.changePin(currentPin, newPin, appendLog, (progress) => {
        changePinProgress = progress;
      });
      showChangePinModal = false;
      changePinSuccess = m.profile_pin_changed();
    } catch (e) {
      changePinError = e instanceof Error ? e.message : String(e);
    } finally {
      changePinLoading = false;
      changePinProgress = null;
    }
  }
</script>

<div
  class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm delay-200 duration-500 md:p-8"
  style="animation-fill-mode: backwards;"
>
  <div class="mb-6 flex items-center gap-3">
    <div class="bg-cn-yellow/10 text-cn-dark rounded-xl p-2.5">
      <Shield size={22} strokeWidth={2.5} />
    </div>
    <h2 class="text-text-main text-lg font-extrabold">{m.profile_security_heading()}</h2>
  </div>

  {#if changePinSuccess}
    <div
      transition:slide={{ duration: 200 }}
      class="mb-5 flex items-center gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm font-bold text-emerald-700 shadow-inner dark:text-emerald-400"
    >
      <CircleCheck size={20} class="shrink-0" />
      {changePinSuccess}
    </div>
  {/if}

  {#if session.isLoggedIn}
    <div class="space-y-4">
      <div
        class="flex items-center justify-between gap-4 rounded-2xl border border-black/5 bg-white/50 p-4 shadow-sm dark:border-white/5 dark:bg-white/5"
      >
        <div class="flex min-w-0 items-center gap-3.5">
          <div class="text-text-muted shrink-0 rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
            <KeyRound size={20} strokeWidth={2.5} />
          </div>
          <div class="min-w-0">
            <p class="text-text-main text-sm font-bold">{m.profile_pin_heading()}</p>
            <p class="text-text-muted mt-0.5 text-xs font-medium">
              {m.profile_pin_desc()}
            </p>
          </div>
        </div>
        <button
          onclick={() => {
            changePinError = '';
            showChangePinModal = true;
          }}
          class="text-text-main focus-visible:ring-text-muted inline-flex shrink-0 items-center gap-2 rounded-xl bg-black/5 px-4 py-2 text-sm font-bold transition-all outline-none hover:bg-black/10 focus-visible:ring-2 active:scale-95 dark:bg-white/10 dark:hover:bg-white/20"
        >
          <KeyRound size={16} strokeWidth={2.5} />
          <span class="hidden sm:inline">{m.profile_pin_change_btn()}</span>
        </button>
      </div>

      {#if biometricAvailable}
        <div
          class="flex items-center justify-between gap-4 rounded-2xl border border-black/5 bg-white/50 p-4 shadow-sm dark:border-white/5 dark:bg-white/5"
        >
          <div class="flex min-w-0 items-center gap-3.5">
            <div class="text-text-muted shrink-0 rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
              <FingerprintPattern size={20} strokeWidth={2.5} />
            </div>
            <div class="min-w-0">
              <p class="text-text-main text-sm font-bold">{m.profile_biometric_heading()}</p>
              <p class="text-text-muted mt-0.5 text-xs font-medium">
                {m.profile_biometric_desc()}
              </p>
            </div>
          </div>
          <button
            role="switch"
            aria-checked={biometricEnabled}
            aria-label={m.profile_biometric_heading()}
            disabled={biometricBusy}
            onclick={toggleBiometric}
            class="focus-visible:ring-cn-yellow relative h-6 w-12 shrink-0 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50
              {biometricEnabled ? 'bg-cn-yellow' : 'bg-black/20 dark:bg-white/15'}"
          >
            <span
              class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200
                {biometricEnabled ? 'translate-x-6' : 'translate-x-0'}"
            ></span>
          </button>
        </div>
      {/if}

      {#if showStaySignedIn}
        <div
          class="flex items-center justify-between gap-4 rounded-2xl border border-black/5 bg-white/50 p-4 shadow-sm dark:border-white/5 dark:bg-white/5"
        >
          <div class="flex min-w-0 items-center gap-3.5">
            <div class="text-text-muted shrink-0 rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
              <LogIn size={20} strokeWidth={2.5} />
            </div>
            <div class="min-w-0">
              <p class="text-text-main text-sm font-bold">{m.profile_stay_signed_in_heading()}</p>
              <p class="text-text-muted mt-0.5 text-xs font-medium">
                {m.profile_stay_signed_in_desc()}
              </p>
            </div>
          </div>
          <button
            role="switch"
            aria-checked={staySignedIn}
            aria-label={m.profile_stay_signed_in_heading()}
            onclick={toggleStaySignedIn}
            class="focus-visible:ring-cn-yellow relative h-6 w-12 shrink-0 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-offset-2
              {staySignedIn ? 'bg-cn-yellow' : 'bg-black/20 dark:bg-white/15'}"
          >
            <span
              class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200
                {staySignedIn ? 'translate-x-6' : 'translate-x-0'}"
            ></span>
          </button>
        </div>
      {/if}

      <div
        class="flex items-center justify-between gap-4 rounded-2xl border border-black/5 bg-white/50 p-4 shadow-sm dark:border-white/5 dark:bg-white/5"
      >
        <div class="flex min-w-0 items-center gap-3.5">
          <div class="text-text-muted shrink-0 rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
            <Monitor size={20} strokeWidth={2.5} />
          </div>
          <div class="min-w-0">
            <p class="text-text-main text-sm font-bold">{m.profile_devices_heading()}</p>
            <p class="text-text-muted mt-0.5 text-xs font-medium">
              {m.profile_devices_desc()}
            </p>
          </div>
        </div>
        <button
          onclick={() => (showDevicePanel = true)}
          class="text-text-main focus-visible:ring-text-muted relative inline-flex shrink-0 items-center gap-2 rounded-xl bg-black/5 px-4 py-2 text-sm font-bold transition-all outline-none hover:bg-black/10 focus-visible:ring-2 active:scale-95 dark:bg-white/10 dark:hover:bg-white/20"
        >
          <Monitor size={16} strokeWidth={2.5} />
          <span class="hidden sm:inline">{m.profile_devices_manage_btn()}</span>
          {#if deviceCount > 1}
            <span
              class="absolute -top-1.5 -right-1.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-orange-500 px-1 text-[10px] font-bold text-white shadow"
            >
              {deviceCount > 99 ? '99+' : deviceCount}
            </span>
          {/if}
        </button>
      </div>
    </div>
  {:else}
    <p class="text-text-muted text-sm leading-relaxed">
      {m.profile_security_locked()}
    </p>
  {/if}
</div>

<ChangePinModal
  open={showChangePinModal}
  onSubmit={handleChangePin}
  onClose={() => (showChangePinModal = false)}
  externalError={changePinError}
  isLoading={changePinLoading}
  loadingProgress={changePinProgress}
/>

{#if session.isLoggedIn}
  <DeviceManagementPanel
    open={showDevicePanel}
    userId={session.userId}
    myDeviceId={session.myDeviceId}
    mlsService={session.ensureMls()}
    onClose={() => (showDevicePanel = false)}
  />
{/if}
