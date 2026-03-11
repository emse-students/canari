<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Camera, Copy, QrCode, Smartphone, Loader2, X } from 'lucide-svelte';

  interface Props {
    isOpen: boolean;
    mode: 'offer' | 'join';
    qrPayload: string;
    qrDataUrl: string;
    joinPayload: string;
    statusText: string;
    isBusy: boolean;
    onJoinPayloadChange: (value: string) => void;
    onConfirmJoin: () => void;
    onCopyPayload: () => void;
    onClose: () => void;
  }

  let {
    isOpen,
    mode,
    qrPayload,
    qrDataUrl,
    joinPayload,
    statusText,
    isBusy,
    onJoinPayloadChange,
    onConfirmJoin,
    onCopyPayload,
    onClose,
  }: Props = $props();

  let videoEl = $state<HTMLVideoElement | null>(null);
  let isScanning = $state(false);
  let scanError = $state('');

  let mediaStream: MediaStream | null = null;
  let scanAnimationFrame: number | null = null;
  let detector: {
    detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
  } | null = null;

  const hasScannerSupport = $derived.by(() => {
    if (typeof window === 'undefined') return false;
    const maybeWindow = window as Window & { BarcodeDetector?: unknown };
    return Boolean(maybeWindow.BarcodeDetector && navigator.mediaDevices?.getUserMedia);
  });

  function cleanupStream() {
    if (scanAnimationFrame !== null) {
      cancelAnimationFrame(scanAnimationFrame);
      scanAnimationFrame = null;
    }
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) {
        track.stop();
      }
      mediaStream = null;
    }
    if (videoEl) {
      videoEl.srcObject = null;
    }
    detector = null;
    isScanning = false;
  }

  async function scanLoop() {
    if (!isScanning || !videoEl || !detector) return;

    try {
      const barcodes = await detector.detect(videoEl);
      const value = barcodes[0]?.rawValue?.trim();
      if (value) {
        onJoinPayloadChange(value);
        cleanupStream();
        return;
      }
    } catch {
      // Ignore transient detector errors and continue scanning.
    }

    scanAnimationFrame = requestAnimationFrame(() => {
      void scanLoop();
    });
  }

  async function toggleScanner() {
    if (isScanning) {
      cleanupStream();
      return;
    }

    scanError = '';
    if (!hasScannerSupport) {
      scanError = 'Scan QR non supporte sur cet appareil. Collez le payload manuellement.';
      return;
    }

    const maybeWindow = window as Window & {
      BarcodeDetector?: new (opts: { formats: string[] }) => {
        detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
      };
    };
    const DetectorCtor = maybeWindow.BarcodeDetector;
    if (!DetectorCtor) {
      scanError = 'Scanner QR indisponible. Collez le payload manuellement.';
      return;
    }

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
        },
        audio: false,
      });

      if (!videoEl) {
        throw new Error('Video indisponible');
      }

      videoEl.srcObject = mediaStream;
      await videoEl.play();
      detector = new DetectorCtor({ formats: ['qr_code'] });
      isScanning = true;
      void scanLoop();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      cleanupStream();
      scanError = `Impossible d'activer la camera: ${msg}`;
    }
  }

  function handleClose() {
    cleanupStream();
    onClose();
  }

  $effect(() => {
    if (!isOpen) {
      cleanupStream();
    }
  });

  onDestroy(() => {
    cleanupStream();
  });
</script>

{#if isOpen}
  <button
    class="fixed inset-0 z-[70] bg-black/40 border-0"
    aria-label="Fermer la fenêtre de synchronisation"
    onclick={handleClose}
  ></button>

  <section
    class="fixed z-[80] inset-x-3 top-10 md:inset-x-auto md:right-8 md:top-20 md:w-[34rem] bg-[var(--cn-surface)] border border-cn-border rounded-2xl shadow-2xl p-4 md:p-5 flex flex-col gap-3"
  >
    <div class="flex items-center justify-between">
      <h3 class="text-base font-semibold text-cn-dark inline-flex items-center gap-2">
        {#if mode === 'offer'}
          <QrCode size={18} /> Synchronisation: appareil source
        {:else}
          <Smartphone size={18} /> Synchronisation: appareil cible
        {/if}
      </h3>
      <button
        class="p-1.5 rounded-lg text-gray-500 hover:bg-cn-bg"
        onclick={handleClose}
        aria-label="Fermer"
      >
        <X size={16} />
      </button>
    </div>

    {#if mode === 'offer'}
      <p class="text-sm text-gray-600">
        Scannez ce payload QR avec l'autre appareil, puis attendez la fin de la synchronisation.
      </p>
      {#if qrDataUrl}
        <div class="rounded-xl border border-cn-border bg-white p-3 flex justify-center">
          <img src={qrDataUrl} alt="QR code de synchronisation" class="w-64 h-64 max-w-full" />
        </div>
      {/if}
      <textarea
        readonly
        value={qrPayload}
        rows="5"
        class="w-full text-xs font-mono px-3 py-2 border border-cn-border rounded-xl bg-cn-bg text-cn-dark"
      ></textarea>
      <button
        onclick={onCopyPayload}
        class="w-full px-3 py-2 rounded-xl bg-cn-dark text-white inline-flex items-center justify-center gap-2"
      >
        <Copy size={14} /> Copier le payload
      </button>
    {:else}
      <p class="text-sm text-gray-600">
        Collez ici le payload obtenu après scan du QR sur l'appareil source.
      </p>
      <button
        onclick={toggleScanner}
        class="w-full px-3 py-2 rounded-xl border border-cn-border bg-cn-bg text-cn-dark inline-flex items-center justify-center gap-2"
      >
        <Camera size={14} />
        {isScanning ? 'Arreter le scan camera' : 'Scanner le QR avec la camera'}
      </button>

      {#if isScanning}
        <div class="rounded-xl border border-cn-border bg-black/90 p-2">
          <video
            bind:this={videoEl}
            autoplay
            playsinline
            muted
            class="w-full h-56 object-cover rounded-lg"
          ></video>
        </div>
      {/if}

      {#if scanError}
        <div
          class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
        >
          {scanError}
        </div>
      {/if}

      <textarea
        value={joinPayload}
        rows="5"
        oninput={(e) => onJoinPayloadChange(e.currentTarget.value)}
        placeholder="Collez ici le payload JSON de synchronisation"
        class="w-full text-xs font-mono px-3 py-2 border border-cn-border rounded-xl bg-cn-bg text-cn-dark"
      ></textarea>
      <button
        onclick={onConfirmJoin}
        disabled={isBusy || !joinPayload.trim()}
        class="w-full px-3 py-2 rounded-xl bg-cn-dark text-white inline-flex items-center justify-center gap-2 disabled:opacity-50"
      >
        {#if isBusy}
          <Loader2 size={14} class="animate-spin" />
        {/if}
        Lancer la synchronisation
      </button>
    {/if}

    {#if statusText}
      <div class="text-xs text-gray-600 bg-cn-bg border border-cn-border rounded-lg px-3 py-2">
        {statusText}
      </div>
    {/if}
  </section>
{/if}
