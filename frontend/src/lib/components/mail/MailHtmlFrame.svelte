<script lang="ts">
  /**
   * AN HTML MAIL IN ITS SANDBOX (docs/wiki/mail-client-transport.md D9; `mailHtml.ts` writes the
   * document, `security/mailFrameScript.js` is the one script it runs).
   *
   * `sandbox="allow-scripts"` and NOTHING ELSE: the frame is an opaque origin (never
   * `allow-same-origin` - the app's keys, its sealed mail password and its cookies stay out of its
   * reach), opens no popup, submits no form and navigates nowhere. `allow-scripts` is for OUR script
   * alone: the frame's policy allows it by hash, and every script of the mail is gone.
   *
   * THE FRAME TELLS ITS PARENT TWO THINGS, by `postMessage`, and the parent accepts them only from
   * THIS frame's window (`event.source`) and only in the shapes `mailFrameMessages.ts` reads:
   *  - its document's height: the frame is drawn that tall (capped at `MAIL_FRAME_MAX_HEIGHT_PX`,
   *    beyond which it scrolls inside, the cap logged), so the reader scrolls the page once;
   *  - a pressed link: routed through `openExternal` - the app's ONE link path, Safe Browsing gate
   *    included - so no `_blank` and no WebView default decide where it opens, on any platform.
   *
   * REMOTE IMAGES ARE BLOCKED until the reader presses "Afficher les images" for THIS message (charter
   * principle 3). The message's own inline images (`cid:`) are fetched from its own parts and shown
   * as data URLs, whatever the choice.
   *
   * THE FRAME IS DRAWN ONCE ITS DOCUMENT IS FINAL, AND EACH DOCUMENT IS A NEW FRAME: changing the
   * `srcdoc` of a frame whose first document is still loading was seen to keep the FIRST one on
   * screen (Chrome; the inline image stayed broken although the attribute held its data URL). So the
   * frame waits until this message's inline parts are settled (`inlineFor === inlineKey`), and a new
   * document (images allowed) replaces the element (`{#key}`) rather than navigating it in place.
   * A download that never settles leaves the pending state drawn, and is LOGGED - never cut short by
   * a clock.
   */
  import { untrack } from 'svelte';
  import { ImageOff } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { MailApi } from '$lib/mail/mailApi';
  import { classifyMailFailure } from '$lib/mail/mailErrors';
  import {
    bytesToDataUrl,
    isInlineImagePart,
    mailFrameDocument,
    remoteImageCount,
  } from '$lib/mail/mailHtml';
  import { cappedFrameHeight, readMailFrameMessage } from '$lib/mail/mailFrameMessages';
  import type { AttachmentRef } from '$lib/mail/mailTypes';
  import { openExternal } from '$lib/utils/openExternal';
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

  /** The frame's sandbox: our one script, nothing else (no same-origin, popup, form, navigation). */
  const SANDBOX = 'allow-scripts';
  /** The height a frame is drawn at before its document reports its own. */
  const START_HEIGHT_PX = 160;
  /** How long an inline download may stay unsettled before it is logged as slow (a log, no cut). */
  const SLOW_INLINE_LOG_MS = 15000;

  let showRemote = $state(false);
  let inlineImages = $state<ReadonlyMap<string, string>>(new Map());
  /** The `inlineKey` `inlineImages` was resolved for: another message's images are never used. */
  let inlineFor = $state('');
  let frame = $state<HTMLIFrameElement | null>(null);
  let frameHeight = $state(START_HEIGHT_PX);

  /** The inline parts this message draws in its body, keyed by the identity of the message. */
  const inlineParts = $derived(attachments.filter(isInlineImagePart));
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
    const slow = setTimeout(() => {
      Log.w(
        'MAIL-UI',
        `inline images still pending after ${SLOW_INLINE_LOG_MS} ms (${parts.length})`
      );
    }, SLOW_INLINE_LOG_MS);
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
      clearTimeout(slow);
      if (cancelled) return;
      inlineImages = resolved;
      inlineFor = key;
      Log.d('MAIL-UI', `inline images settled (${resolved.size}/${parts.length})`);
    })();
    return () => {
      cancelled = true;
      clearTimeout(slow);
    };
  });

  /** One message from the window: acted on only when it comes from THIS frame, in a known shape. */
  function onMessage(event: MessageEvent) {
    if (!frame || event.source !== frame.contentWindow) return;
    const message = readMailFrameMessage(event.data);
    if (message === null) {
      Log.w('MAIL-UI', 'a message from the mail frame was not one its script sends - dropped');
      return;
    }
    if (message.kind === 'height') {
      const { height, capped } = cappedFrameHeight(message.height);
      if (capped) Log.w('MAIL-UI', `mail frame height capped (${message.height} px reported)`);
      if (height !== frameHeight) frameHeight = height;
      return;
    }
    Log.d('MAIL-UI', 'a link of the mail is opened through the app');
    void openExternal(message.href);
  }

  $effect(() => {
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
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
    <div class="h-40 w-full rounded-lg bg-white" aria-busy="true" data-mail-frame-pending></div>
  {:else}
    {#key frameDocument}
      <iframe
        bind:this={frame}
        {title}
        srcdoc={frameDocument}
        sandbox={SANDBOX}
        referrerpolicy="no-referrer"
        class="w-full rounded-lg border-0 bg-white"
        style="height: {frameHeight}px"
      ></iframe>
    {/key}
  {/if}
</div>
