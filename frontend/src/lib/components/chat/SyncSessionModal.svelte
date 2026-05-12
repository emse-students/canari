<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import jsQR from 'jsqr';
  import { Camera, Copy, QrCode, Smartphone, Loader2, X, AlertCircle, Info } from 'lucide-svelte';
  import { portal } from '$lib/actions/portal';
  import { fade, fly } from 'svelte/transition';

  interface Props {
    /** Whether the sync session modal is visible. */
    isOpen: boolean;
    /** Whether the local device is the QR source (offer) or the scanner (join). */
    mode: 'offer' | 'join';
    /** Raw text payload encoded in the QR code, used as a copy-fallback. */
    qrPayload: string;
    /** Data URL of the generated QR code image. */
    qrDataUrl: string;
    /** Current value of the manual join payload input. */
    joinPayload: string;
    /** Status message displayed below the QR or scanner area. */
    statusText: string;
    /** Whether a sync operation is currently in progress. */
    isBusy: boolean;
    /** Callback fired when the join payload input changes. */
    onJoinPayloadChange: (value: string) => void;
    /** Callback to confirm and start the join operation with the current payload. */
    onConfirmJoin: () => void;
    /** Callback to copy the QR payload text to the clipboard. */
    onCopyPayload: () => void;
    /** Callback to close the modal and clean up camera resources. */
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
  let showPayloadFallback = $state(false);
  let showManualPaste = $state(false);

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
        onConfirmJoin();
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
      scanError = 'Scan QR non supporté sur cet appareil. Collez le payload manuellement.';
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
        throw new Error('Vidéo indisponible');
      }

      videoEl.srcObject = mediaStream;
      await videoEl.play();
      detector = DetectorCtor ? new DetectorCtor({ formats: ['qr_code'] }) : null;
      if (!detector) {
        scanError =
          'Mode compatibilité activé: scan logiciel (si instable, utilisez le collage manuel).';
      }
      void scanLoop();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      cleanupStream();
      scanError = `Impossible d'activer la caméra: ${msg}`;
      showManualPaste = true;
    }
  }

  function handleClose() {
    cleanupStream();
    onClose();
  }

  $effect(() => {
    if (!isOpen) {
      cleanupStream();
      showPayloadFallback = false;
      showManualPaste = false;
    }
  });

  onDestroy(() => {
    cleanupStream();
  });
</script>

{#if isOpen}
  <div
    use:portal
    class="fixed inset-0 z-[190] pointer-events-none flex items-center justify-center"
    style="padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left))"
  >
    <!-- Overlay Assombri -->
    <button
      class="absolute inset-0 bg-black/50 backdrop-blur-sm border-0 pointer-events-auto transition-opacity"
      aria-label="Fermer la fenêtre de synchronisation"
      onclick={handleClose}
      transition:fade={{ duration: 250 }}
    ></button>

    <!-- Fenêtre Modale -->
    <section
      class="relative pointer-events-auto w-full md:w-[36rem] max-h-[92dvh] overflow-y-auto bg-white/90 dark:bg-[#151B2C]/95 backdrop-blur-2xl border border-black/5 dark:border-white/10 rounded-3xl shadow-2xl p-6 md:p-8 flex flex-col gap-6"
      transition:fly={{ y: 20, duration: 300, easing: (t) => t * (2 - t) }}
    >
      <!-- En-tête -->
      <div class="flex items-center justify-between">
        <h3 class="text-lg font-bold text-text-main inline-flex items-center gap-2.5">
          {#if mode === 'offer'}
            <div class="p-2 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-xl">
              <QrCode size={20} strokeWidth={2.5} />
            </div>
            Synchronisation<span class="opacity-60 font-medium">| Source</span>
          {:else}
            <div class="p-2 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-xl">
              <Smartphone size={20} strokeWidth={2.5} />
            </div>
            Synchronisation<span class="opacity-60 font-medium">| Cible</span>
          {/if}
        </h3>
        <button
          class="p-2 rounded-full text-text-muted hover:bg-black/5 dark:hover:bg-white/10 hover:text-red-500 transition-colors focus-visible:ring-2 focus-visible:ring-text-muted outline-none"
          onclick={handleClose}
          aria-label="Fermer"
        >
          <X size={20} />
        </button>
      </div>

      <!-- Mode: Source (Générateur de QR) -->
      {#if mode === 'offer'}
        <p class="text-sm text-text-muted leading-relaxed">
          Scannez ce QR code avec l'appareil que vous souhaitez synchroniser, puis attendez la fin
          de l'opération.
        </p>

        {#if qrDataUrl}
          <div class="flex justify-center">
            <div class="rounded-[2rem] border border-black/10 bg-white p-5 shadow-inner">
              <img
                src={qrDataUrl}
                alt="QR code de synchronisation"
                class="w-56 h-56 max-w-full rendering-pixelated"
              />
            </div>
          </div>
        {/if}

        <div class="text-center mt-2">
          <button
            onclick={() => (showPayloadFallback = !showPayloadFallback)}
            class="text-xs font-semibold text-text-muted hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
          >
            {showPayloadFallback ? 'Masquer le code texte' : 'Impossible de scanner le QR code ?'}
          </button>
        </div>

        {#if showPayloadFallback}
          <div transition:fly={{ y: -10, duration: 200 }} class="flex flex-col gap-3">
            <textarea
              readonly
              value={qrPayload}
              rows="4"
              class="w-full text-xs font-mono px-4 py-3 border border-black/10 dark:border-white/10 rounded-2xl bg-black/5 dark:bg-black/40 text-text-main shadow-inner focus:outline-none resize-none"
            ></textarea>
            <button
              onclick={onCopyPayload}
              class="w-full px-4 py-3 rounded-xl bg-black/5 dark:bg-white/10 text-text-main font-bold text-sm inline-flex items-center justify-center gap-2 hover:bg-black/10 dark:hover:bg-white/20 active:scale-95 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <Copy size={16} /> Copier le code (Dernier recours)
            </button>
          </div>
        {/if}

        <!-- Mode: Cible (Scanner) -->
      {:else}
        {#if hasScannerSupport}
          <button
            onclick={toggleScanner}
            class="w-full px-4 py-3.5 rounded-2xl border-2 border-transparent bg-amber-500 hover:bg-amber-400 text-[#151B2C] font-bold inline-flex items-center justify-center gap-2.5 active:scale-[0.98] transition-all shadow-md shadow-amber-500/20 outline-none focus-visible:ring-4 focus-visible:ring-amber-500/50"
          >
            <Camera size={18} strokeWidth={2.5} />
            {isScanning ? 'Arrêter la caméra' : 'Scanner le QR Code'}
          </button>
        {/if}

        {#if isScanning}
          <div
            class="rounded-[2rem] border border-black/10 dark:border-white/10 bg-black overflow-hidden shadow-inner relative"
            transition:fade={{ duration: 200 }}
          >
            <!-- Repère de scan (Guide visuel) -->
            <div
              class="absolute inset-0 pointer-events-none border-[40px] border-black/40 z-10"
            ></div>
            <video bind:this={videoEl} autoplay playsinline muted class="w-full h-64 object-cover"
            ></video>
          </div>
        {/if}

        {#if scanError}
          <div
            transition:fly={{ y: -5, duration: 200 }}
            class="text-xs font-medium text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 flex gap-3 items-start"
          >
            <AlertCircle size={16} class="shrink-0 mt-0.5" />
            <span>{scanError}</span>
          </div>
        {/if}

        {#if !hasScannerSupport || showManualPaste}
          <div transition:fly={{ y: -10, duration: 200 }} class="flex flex-col gap-3">
            <textarea
              value={joinPayload}
              rows="4"
              oninput={(e) => onJoinPayloadChange(e.currentTarget.value)}
              placeholder="Collez ici le code texte de synchronisation généré par l'autre appareil..."
              class="w-full text-xs font-mono px-4 py-3 border border-black/10 dark:border-white/10 rounded-2xl bg-black/5 dark:bg-black/40 text-text-main shadow-inner focus:outline-none focus:ring-2 focus:ring-amber-500/50 resize-none placeholder:font-sans placeholder:text-text-muted/70"
            ></textarea>

            <button
              onclick={onConfirmJoin}
              disabled={isBusy || !joinPayload.trim()}
              class="w-full px-4 py-3.5 rounded-2xl bg-amber-500 text-[#151B2C] font-bold inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all shadow-md shadow-amber-500/20"
            >
              {#if isBusy}
                <Loader2 size={16} class="animate-spin" />
                Synchronisation en cours...
              {:else}
                Lancer la synchronisation
              {/if}
            </button>
          </div>
        {:else}
          <div class="text-center mt-2">
            <button
              onclick={() => (showManualPaste = true)}
              class="text-xs font-semibold text-text-muted hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
            >
              Je ne peux pas scanner — Coller le code texte manuellement
            </button>
          </div>
        {/if}
      {/if}

      <!-- Messages de statut globaux -->
      {#if statusText}
        <div
          transition:fly={{ y: 5, duration: 200 }}
          class="text-xs font-medium text-blue-700 dark:text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-xl px-4 py-3 flex items-center gap-3"
        >
          <Info size={16} class="shrink-0" />
          <span>{statusText}</span>
        </div>
      {/if}
    </section>
  </div>
{/if}
