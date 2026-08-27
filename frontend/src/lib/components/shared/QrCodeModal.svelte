<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { Download } from '@lucide/svelte';
  import { renderQrPng, qrFileName } from '$lib/utils/qrCode';
  import { downloadDecryptedFile } from '$lib/utils/fileDownload';
  import { m } from '$lib/paraglide/messages';

  /**
   * Shows the QR code for one public Canari link, and offers it as a PNG.
   *
   * The component knows nothing about what it is pointing at: the caller hands it an already
   * absolute URL (`publicAppUrl`), the line saying what scanning it opens, and the label the file
   * name is built from. That is what lets the same modal serve a form, and whatever comes next,
   * without a prop naming a feature.
   *
   * The PNG is rendered ONCE per opening and both the preview and the download read that single
   * blob, so what a person sees is byte-for-byte what they save.
   */
  interface Props {
    open: boolean;
    onClose: () => void;
    /** Absolute public URL the code encodes - the same one the copy-link control hands out. */
    url: string;
    /**
     * Human label: printed on the plate under the code, and the download file name is derived
     * from it. A form's title, at every current call site.
     */
    label: string;
    /** Who is behind it - printed under the label when known, left out entirely when not. */
    owner?: string | null;
    /** One line saying WHAT scanning it opens, in the caller's own words. */
    intro: string;
  }

  let { open, onClose, url, label, owner = null, intro }: Props = $props();

  let previewUrl = $state<string | null>(null);
  let rendering = $state(false);
  let failed = $state(false);
  /** Deliberately not reactive: nothing renders from the bytes, the download just reads them. */
  let png: Blob | null = null;

  $effect(() => {
    if (!open || !url) return;

    const wanted = url;
    const caption = { title: label, subtitle: owner };
    let cancelled = false;
    let objectUrl: string | null = null;
    rendering = true;
    failed = false;

    void (async () => {
      try {
        const blob = await renderQrPng(wanted, caption);
        if (cancelled) return;
        png = blob;
        objectUrl = URL.createObjectURL(blob);
        previewUrl = objectUrl;
      } catch (err) {
        // The bird is a bundled asset and the encoder is synchronous: reaching this means
        // something is broken, so it is never quietly swallowed into a blank frame.
        console.error('[qr] could not render the code', err);
        if (!cancelled) failed = true;
      } finally {
        if (!cancelled) rendering = false;
      }
    })();

    return () => {
      cancelled = true;
      png = null;
      previewUrl = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  });

  async function download() {
    if (!png) return;
    console.debug(`[qr] downloading ${png.size} bytes for "${label}"`);
    await downloadDecryptedFile(png, qrFileName(label));
  }
</script>

<Modal {open} title={m.qr_modal_title()} maxWidth="max-w-sm" {onClose}>
  <div class="space-y-4 text-sm">
    <p class="text-text-muted text-center">{intro}</p>

    <div class="flex justify-center">
      {#if previewUrl}
        <img
          src={previewUrl}
          alt={m.qr_image_alt({ url })}
          class="border-cn-border h-auto w-full max-w-[16rem] rounded-2xl border shadow-sm"
        />
      {:else}
        <div
          class="border-cn-border bg-cn-surface-alt flex aspect-square w-full max-w-[16rem] items-center justify-center rounded-2xl border"
        >
          {#if failed}
            <p class="text-red-err px-6 text-center text-xs font-semibold">{m.qr_error()}</p>
          {:else if rendering}
            <div
              class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
            ></div>
          {/if}
        </div>
      {/if}
    </div>

    <p class="text-text-muted text-center font-mono text-[11px] break-all">{url}</p>

    <Button
      class="w-full"
      disabled={!previewUrl}
      onclick={download}
      aria-label={m.qr_download_button()}
    >
      <Download size={16} />
      {m.qr_download_button()}
    </Button>
  </div>
</Modal>
