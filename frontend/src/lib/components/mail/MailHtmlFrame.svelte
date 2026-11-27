<script lang="ts">
  /**
   * AN HTML MAIL IN ITS SANDBOX (docs/wiki/mail-client.md D9; `mailHtml.ts` writes the document).
   *
   * `sandbox` grants neither `allow-scripts` nor `allow-same-origin`: nothing in the mail runs and it
   * cannot reach the app. It grants `allow-popups` (and lets the popup leave the sandbox) so a link,
   * which the document opens in a new browsing context (`<base target="_blank">`, `noopener`),
   * opens OUTSIDE the app - in the browser on the web.
   *
   * REMOTE IMAGES ARE BLOCKED until the reader presses "Afficher les images" for THIS message (charter
   * principle 3). The message's own inline images (`cid:`) are fetched from its own parts and shown
   * as data URLs, whatever the choice.
   *
   * THE FRAME HAS A FIXED HEIGHT AND SCROLLS INSIDE: without `allow-same-origin` the app cannot read
   * the document's height, and granting it to measure is the one thing D9 refuses. The height is a
   * share of the viewport, so a long mail scrolls in its frame and a short one leaves white below it.
   *
   * THE FRAME IS DRAWN ONCE ITS DOCUMENT IS FINAL, AND EACH DOCUMENT IS A NEW FRAME: changing the
   * `srcdoc` of a frame whose first document is still loading was seen to keep the FIRST one on
   * screen (Chrome; the inline image stayed broken although the attribute held its data URL). So the
   * frame waits until this message's inline parts are settled (`inlineFor === inlineKey`), and a new
   * document (images allowed) replaces the element (`{#key}`) rather than navigating it in place.
   */
  import { untrack } from 'svelte';
  import { ImageOff } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { MailApi } from '$lib/mail/mailApi';
  import { classifyMailFailure } from '$lib/mail/mailErrors';
  import { bytesToDataUrl, mailFrameDocument, remoteImageCount } from '$lib/mail/mailHtml';
  import type { AttachmentRef } from '$lib/mail/mailTypes';
  import { Log } from '$lib/utils/Log';

  interface Props {
    html: string;
    /** The message's parts; the inline images among them are resolved for `cid:`. */
    attachments: readonly AttachmentRef[];
    api: Pick<MailApi, 'download'>;
    /** The frame's accessible name (the subject). */
    title: string;
  }

  let { html, attachments, api, title }: Props = $props();

  let showRemote = $state(false);
  let inlineImages = $state<ReadonlyMap<string, string>>(new Map());
  /** The `inlineKey` `inlineImages` was resolved for: another message's images are never used. */
  let inlineFor = $state('');

  /** The inline parts this message names, keyed by the identity of the message. */
  const inlineParts = $derived(attachments.filter((a) => a.contentId !== null && a.inline));
  const inlineKey = $derived(inlineParts.map((a) => `${a.messageId}:${a.part}`).join(','));
  /** True once this message's inline parts are settled (loaded or failed), so the document is final. */
  const settled = $derived(inlineKey === '' || inlineFor === inlineKey);
  const NO_IMAGES: ReadonlyMap<string, string> = new Map();

  const remoteCount = $derived(remoteImageCount(html));
  const frameDocument = $derived(
    settled
      ? mailFrameDocument(html, {
          showRemoteImages: showRemote,
          inlineImages: inlineKey === '' ? NO_IMAGES : inlineImages,
        })
      : null
  );

  $effect(() => {
    const key = inlineKey;
    const parts = untrack(() => inlineParts);
    if (!key) return;
    let cancelled = false;
    void (async () => {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- built whole, then assigned once
      const resolved = new Map<string, string>();
      for (const part of parts) {
        try {
          const bytes = await api.download(part);
          resolved.set(part.contentId!, bytesToDataUrl(bytes, part.contentType));
        } catch (err) {
          Log.w('MAIL-UI', `an inline image did not load (${classifyMailFailure(err).kind})`);
        }
      }
      if (cancelled) return;
      inlineImages = resolved;
      inlineFor = key;
      Log.d('MAIL-UI', `inline images settled (${resolved.size}/${parts.length})`);
    })();
    return () => {
      cancelled = true;
    };
  });

  function allowImages() {
    Log.d('MAIL-UI', `remote images shown for one message (${remoteCount})`);
    showRemote = true;
  }
</script>

<div class="flex flex-col gap-2" data-mail-html>
  {#if remoteCount > 0 && !showRemote}
    <div
      class="bg-cn-surface-alt text-text-muted flex items-center gap-2 rounded-lg px-3 py-2 text-sm"
      data-mail-images-blocked
    >
      <ImageOff size={18} aria-hidden="true" />
      <span class="flex-1">{m.mail_images_blocked()}</span>
      <Button variant="link" onclick={allowImages}>{m.mail_images_show()}</Button>
    </div>
  {/if}
  {#if frameDocument === null}
    <div class="h-[60vh] w-full rounded-lg bg-white" aria-busy="true" data-mail-frame-pending></div>
  {:else}
    {#key frameDocument}
      <iframe
        {title}
        srcdoc={frameDocument}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
        class="h-[60vh] w-full rounded-lg border-0 bg-white"
      ></iframe>
    {/key}
  {/if}
</div>
