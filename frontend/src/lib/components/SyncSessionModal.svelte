<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import jsQR from 'jsqr';
  import { Camera, Copy, QrCode, Smartphone, Loader2, X } from 'lucide-svelte';
  import { portal } from '$lib/actions/portal';

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
  let scanCanvas: HTMLCanvasElement | null = null;
  let detector: {
    detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
  } | null = null;

  const hasScannerSupport = $derived.by(() => {
    return typeof window !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
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
    if (!isScanning || !videoEl) return;

    try {
      if (videoEl.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        scanAnimationFrame = requestAnimationFrame(() => {
          void scanLoop();
        });
        return;
      }

      let value = '';

      if (detector) {
        try {
          const barcodes = await detector.detect(videoEl);
          value = barcodes[0]?.rawValue?.trim() ?? '';
        } catch {
          // If BarcodeDetector fails at runtime, fallback to jsQR below.
        }
      }

      if (!value) {
        if (!scanCanvas) scanCanvas = document.createElement('canvas');
        const canvas = scanCanvas;
        const width = videoEl.videoWidth;
        const height = videoEl.videoHeight;

        if (width > 0 && height > 0) {
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(videoEl, 0, 0, width, height);
            const imageData = ctx.getImageData(0, 0, width, height);
            const decoded = jsQR(imageData.data, width, height, {
              inversionAttempts: 'dontInvert',
            });
            value = decoded?.data?.trim() ?? '';
          }
        }
      }

      if (value) {
        onJoinPayloadChange(value);
        cleanupStream();
        return;
      }
    } catch {
      // Ignore transient detector/camera errors and continue scanning.
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

    isScanning = true;
    await tick();

    const maybeWindow = window as Window & {
      BarcodeDetector?: new (opts: { formats: string[] }) => {
        detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
      };
    };
    const DetectorCtor = maybeWindow.BarcodeDetector;

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
      detector = DetectorCtor ? new DetectorCtor({ formats: ['qr_code'] }) : null;
      if (!detector) {
        scanError =
          'Mode compatibilite active: scan logiciel (si instable, utilisez le collage manuel).';
      }
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
  <div use:portal class="fixed inset-0 z-[190] pointer-events-none">
    <button
      class="absolute inset-0 bg-black/40 border-0 pointer-events-auto"
      aria-label="Fermer la fenêtre de synchronisation"
      onclick={handleClose}
    ></button>

    <section
      class="absolute pointer-events-auto inset-x-3 top-4 md:inset-x-auto md:right-8 md:top-20 md:w-[34rem] max-h-[92dvh] overflow-y-auto bg-[var(--cn-surface)] border border-cn-border rounded-2xl shadow-2xl p-4 md:p-5 flex flex-col gap-3"
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
        class="p-1.5 rounded-lg text-cn-muted hover:bg-cn-bg"
        onclick={handleClose}
        aria-label="Fermer"
      >
        <X size={16} />
      </button>
    </div>

    {#if mode === 'offer'}
      <p class="text-sm text-cn-muted">
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
      <p class="text-sm text-cn-muted">
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
      <div class="text-xs text-cn-muted bg-cn-bg border border-cn-border rounded-lg px-3 py-2">
        {statusText}
      </div>
    {/if}
    </section>
  </div>
{/if}
