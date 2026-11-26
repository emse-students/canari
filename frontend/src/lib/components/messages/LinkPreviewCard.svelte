<script lang="ts">
  import { Globe, Images } from '@lucide/svelte';
  import AttachmentCard from '$lib/components/shared/AttachmentCard.svelte';
  import CanariLinkPreviewMedia from '$lib/components/shared/CanariLinkPreviewMedia.svelte';
  import { m } from '$lib/paraglide/messages';
  import SharedReelViewer from '$lib/components/reels/SharedReelViewer.svelte';
  import { getToken } from '$lib/stores/auth';
  import { navigateInAppFromHref } from '$lib/utils/appLinkNavigation';
  import { fetchCanariLinkPreview, type CanariLinkPreview } from '$lib/utils/canariLinkPreview';
  import { CANARI_BADGE_LABEL } from '$lib/utils/canariLinkPreviewFormat';
  import { openExternal } from '$lib/utils/openExternal';
  import {
    ecosystemCoverCardFor,
    ecosystemSiteFor,
    ecosystemSquareCoverUrl,
  } from '$lib/utils/ecosystemHosts';
  import { faviconCandidates } from '$lib/utils/faviconCandidates';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { deliveryUrl } from '$lib/utils/apiUrl';
  import { proxiedPreviewImageUrl } from '$lib/utils/previewImageProxy';
  import { nearViewport } from '$lib/actions/nearViewport';
  import { Log } from '$lib/utils/Log';
  import { ensurePreviewTicket } from '$lib/utils/previewTicket.svelte';
  import { inAppPathFromHref, isInAppHref, publicAppLinkLabel } from '$lib/utils/publicAppUrl';

  interface Props {
    /** The URL whose Open Graph / meta preview should be fetched and displayed. */
    url: string;
    /** When true, removes the top margin (card is the only element in the bubble). */
    standalone?: boolean;
    /** Drawn large: the post's only attachment (`planPostAttachments`). */
    hero?: boolean;
  }

  let { url, standalone = false, hero = false }: Props = $props();

  const isInApp = $derived(isInAppHref(url));

  const parsed = $derived.by(() => {
    try {
      const u = new URL(url);
      return {
        host: u.hostname.replace(/^www\./, ''),
        href: u.href,
        path: u.pathname && u.pathname !== '/' ? u.pathname : '',
      };
    } catch {
      return {
        host: url,
        href: url,
        path: '',
      };
    }
  });

  /**
   * The site behind an external link, when it is one of ours. Both the chip
   * label and the choice of card come from the registry rather than from a
   * hostname compared in place, so a fifth site is one entry there.
   */
  const ecosystemSite = $derived(ecosystemSiteFor(parsed.host));
  const coverCard = $derived(ecosystemCoverCardFor(parsed.host, parsed.path));
  const squareCoverUrl = $derived(ecosystemSquareCoverUrl(parsed.href));

  const fallbackInAppLabel = $derived(publicAppLinkLabel(url));
  const inAppPath = $derived(inAppPathFromHref(url));

  interface ExternalPreviewPayload {
    url: string;
    title?: string;
    description?: string;
    image?: string;
    siteName?: string;
    /** The site's own icon, resolved server-side from its `<link rel="icon">`. */
    icon?: string;
  }

  let canariPreview = $state<CanariLinkPreview | null>(null);
  let externalPreview = $state<ExternalPreviewPayload | null>(null);
  let isLoading = $state(false);
  /**
   * Live token for decrypting a post's OWN banner image (`canariPreview.postImage`), fetched only
   * when a preview actually carries one - most cards never do, and `getToken()` is cheap but not
   * free. Unlike `imageUrl` (a plain public URL), this image is still ciphertext: `PostMedia`
   * decrypts it the exact same way the post itself does in its own feed, to this same
   * already-authenticated viewer.
   */
  let postImageAuthToken = $state('');
  /**
   * `PostMedia` drags in the whole decrypt/lightbox/PDF-viewer stack (`MediaService`, the global
   * chat singleton...) - weight every OTHER link preview (external sites, forms, associations,
   * profiles, a post with no photo of its own) has no reason to pay. Loaded on demand, exactly
   * when a post preview turns out to carry its own image.
   */
  let PostMedia = $state<typeof import('$lib/components/posts/PostMedia.svelte').default | null>(
    null
  );

  /**
   * Whether this card has come near enough to the viewport to be worth a request.
   *
   * THE METADATA FETCH USED TO FIRE ON RENDER, for every card the page mounted. A feed of a dozen
   * link posts therefore opened a dozen `/api/mls/link-preview` requests during the cold start, all
   * of them for cards below the fold, competing with the boot for the same connection. The `<img>`
   * beside them was already deferred by `loading="lazy"`; this gives the request that decides what
   * the card SAYS the same rule the browser applies to the picture.
   */
  let isNear = $state(false);

  /**
   * A card that has not asked yet looks exactly like a card that is waiting for an answer, and that
   * is deliberate: both are "no answer yet". Without it, an above-the-fold card would paint its
   * empty fallback for the one frame between layout and the observer's first callback, then flip
   * into the skeleton - a flash saying "nothing here" about a card that is about to be filled.
   */
  const isPending = $derived(!isNear || isLoading);

  $effect(() => {
    const targetUrl = url;
    // Reading `isNear` here is what subscribes this effect to it: the fetch starts on the edge
    // from not-near to near, and on a changed `url`, and on nothing else.
    if (!isNear) return;
    let cancelled = false;

    async function load() {
      isLoading = true;
      canariPreview = null;
      externalPreview = null;

      // Minted before the images are derived, so the first render already carries a ticket rather
      // than painting empty and repainting. It is a no-op once one is held.
      void ensurePreviewTicket();

      try {
        if (isInAppHref(targetUrl)) {
          const data = await fetchCanariLinkPreview(targetUrl);
          if (cancelled) return;
          canariPreview = data;
          if (data?.postImage) {
            const [token, mod] = await Promise.all([
              getToken(),
              import('$lib/components/posts/PostMedia.svelte'),
            ]);
            if (cancelled) return;
            postImageAuthToken = token;
            PostMedia = mod.default;
          }
          return;
        }

        // `apiFetch`, not `fetch`: nginx's `auth_request` identifies a caller from the
        // `Authorization` header alone, so a bare same-origin fetch reaches this route with no
        // session at all - which is what made it a preview service for anybody who could name a URL.
        const endpoint = `${deliveryUrl()}/api/mls/link-preview?url=${encodeURIComponent(parsed.href)}`;
        const res = await apiFetch(endpoint);
        if (res.ok) {
          const data = (await res.json()) as ExternalPreviewPayload;
          if (!cancelled) externalPreview = data;
        }
      } catch (error) {
        // A preview that fails degrades to the bare host, which is a perfectly good card - but the
        // failure itself must not be silent. This is the only trace a lost preview leaves, and a
        // rate is the only way to tell one dead site from a proxy that has stopped answering.
        Log.d('LINK_PREVIEW', error instanceof Error ? error : new Error(String(error)));
      } finally {
        if (!cancelled) isLoading = false;
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  });

  const cardTitle = $derived(
    isInApp
      ? (canariPreview?.title ?? fallbackInAppLabel ?? 'Canari')
      : externalPreview?.title ||
          (coverCard ? coverCard.fallbackTitle() : parsed.path || parsed.href)
  );

  /**
   * The amber chip. In-app it names the KIND of content (Publication, Association...),
   * falling back to the brand for a plain route; for an external link it is the HOST,
   * never `siteName`. The one rule behind both: a great many sites set `og:site_name`
   * to the page title, and a Canari route had nothing but its own label to show, so
   * either way the chip and the title below it printed the same sentence twice. What
   * belongs here is the thing the title does not already say - where the link goes.
   *
   * A site of our own ecosystem shows its name instead of its hostname: the rule is
   * unchanged, the reader simply already knows the destination by that name, and
   * `sky.mitv.fr` names it to nobody but whoever deployed it.
   */
  const cardCategory = $derived(
    isInApp
      ? (canariPreview?.categoryLabel ?? CANARI_BADGE_LABEL)
      : (ecosystemSite?.label ?? parsed.host)
  );

  const cardSubtitle = $derived(isInApp ? canariPreview?.subtitle : externalPreview?.description);

  /** Resolves once we know whether `src` decodes as an image. Never rejects. */
  function loadsAsImage(src: string): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = new Image();
      probe.onload = () => resolve(probe.naturalWidth > 0);
      probe.onerror = () => resolve(false);
      probe.src = src;
    });
  }

  /** The Open Graph image, likewise fetched through the proxy rather than from its host. */
  const previewImageUrl = $derived(proxiedPreviewImageUrl(externalPreview?.image));

  /**
   * THE CASCADE HAS TO COME BACK DOWN, AND A URL EXISTING IS NOT AN IMAGE EXISTING.
   *
   * `og:image` -> declared icon -> conventional paths -> globe is the intended order, but the
   * first step used to be tested by `previewImageUrl` being non-empty, which only says the page
   * DECLARED one. A declaration that 404s left a 64px empty square on screen with a perfectly
   * good favicon one step below, never reached - measured on production 2026-09-23, where the
   * declaration was itself built against the wrong base.
   *
   * A probe rather than an `onerror` on the displayed element, for the reason the favicon chain
   * already documents below: that element is reused as the payload arrives, so an error queued
   * for the previous src still fires against the next one. The probe owns its element, so its
   * answer can only be about the URL that was asked - and it costs no second download, since the
   * proxy answers `max-age` and the displayed `<img>` reads the same HTTP cache entry.
   */
  let previewImageBroken = $state(false);
  $effect(() => {
    const src = previewImageUrl;
    previewImageBroken = false;
    if (!src) return;
    let cancelled = false;
    void loadsAsImage(src).then((ok) => {
      if (!cancelled) previewImageBroken = !ok;
    });
    return () => {
      cancelled = true;
    };
  });

  /** Whether the Open Graph image is what the card draws - the first rung of the cascade. */
  const showsPreviewImage = $derived(Boolean(previewImageUrl) && !previewImageBroken);

  /**
   * An album's cover, square when the site serves one (`ecosystemSquareCoverUrl`, known from the
   * URL alone, so it paints before the preview answers), else the page's Open Graph picture. Fetched
   * through Canari's proxy like every preview picture.
   */
  const coverUrl = $derived(
    coverCard ? proxiedPreviewImageUrl(squareCoverUrl ?? externalPreview?.image) : ''
  );

  /**
   * Whether the cover is PROVEN to decode - the Open Graph picture's rule (`previewImageBroken`): a
   * URL existing is not an image existing, and an album that is gone or private answers an error,
   * which drew a broken-image glyph over the whole banner.
   */
  let coverLoads = $state(false);
  $effect(() => {
    const src = coverUrl;
    coverLoads = false;
    if (!src) return;
    let cancelled = false;
    void loadsAsImage(src).then((ok) => {
      if (cancelled) return;
      coverLoads = ok;
      if (!ok)
        Log.d('LINK_PREVIEW', `album cover did not decode, card drawn without it: ${parsed.host}`);
    });
    return () => {
      cancelled = true;
    };
  });

  /**
   * THE HERO BANNER DRAWS THE WIDE COVER, NOT THE SQUARE ONE (owner, 2026-11-26: a MiGallery card
   * was visibly pixelated).
   *
   * The square cover is 400x400 and is right for the tile. The hero banner is about 640 CSS px wide
   * (1300 device px at 2x) and cropped to 1.91:1, so it was stretching the middle 400x209 band of
   * that square about three times. The preview payload carries the site's own 1200x630 cover as
   * `image` - and OMITS it for a private album, whose card keeps the square it always had - so
   * the banner draws it when it is there and PROVEN to decode, and the square otherwise.
   */
  const wideCoverUrl = $derived(coverCard ? proxiedPreviewImageUrl(externalPreview?.image) : '');
  let wideCoverLoads = $state(false);
  $effect(() => {
    const src = wideCoverUrl;
    wideCoverLoads = false;
    if (!src) return;
    let cancelled = false;
    void loadsAsImage(src).then((ok) => {
      if (cancelled) return;
      wideCoverLoads = ok;
      if (!ok)
        Log.d('LINK_PREVIEW', `wide cover did not decode, banner keeps the square: ${parsed.host}`);
    });
    return () => {
      cancelled = true;
    };
  });
  /** What the hero banner draws: the wide cover when proven, else the square, else the OG image. */
  const bannerUrl = $derived(
    coverCard ? (wideCoverLoads ? wideCoverUrl : coverUrl) : previewImageUrl
  );

  /** Whether the post preview carries its own photo, decrypted for this reader. */
  const hasPostImage = $derived(
    isInApp && Boolean(canariPreview?.postImage && postImageAuthToken && PostMedia)
  );

  /** What a HERO card can put forward: a picture. Without one it stays a row. */
  const hasBanner = $derived(
    hasPostImage || (coverCard ? coverLoads : !isInApp && showsPreviewImage)
  );

  /**
   * The site's own icon, as an ordered list of things to try. The preview endpoint
   * resolves the declared one from the page it already downloaded; the conventional
   * paths follow it, in any format, so a single 404 does not end the search.
   * Deliberately NOT a third-party icon service: those only know hosts they have
   * crawled and answer a generic globe for anything private or unindexed - which is
   * why self-hosted sites showed a placeholder - and asking one would hand every
   * browsed hostname to a third party from inside an end-to-end encrypted
   * conversation.
   *
   * Every candidate goes through Canari's image proxy, which is what keeps that
   * last sentence true for the conventional paths too - they are derived here,
   * so nothing server-side would otherwise have rewritten them.
   *
   * Empty for a cover card: that branch shows the site's name and its cover, and
   * no favicon anywhere. Probing one is a chain of outbound requests whose answer
   * nothing reads - and whose failures are the `404` / `415` console lines a
   * MiGallery album printed on every render.
   *
   * Empty for the same reason once the Open Graph image is proven: the icon it
   * would stand in for is already on screen, so the chain is the same unread
   * answer. It is rebuilt - and only then walked - if that image turns out not to
   * decode, which is what makes this a cascade rather than two searches racing.
   *
   * And empty while the card is still pending, because the answer to "what icon
   * does this site declare" has not arrived yet: walking the conventional paths
   * first asks the network a question the payload is about to answer, and every
   * one of those requests is thrown away the moment it does.
   */
  const faviconChain = $derived(
    coverCard || isPending || showsPreviewImage
      ? []
      : faviconCandidates(parsed.href, externalPreview?.icon)
          .map(proxiedPreviewImageUrl)
          .filter(Boolean)
  );

  /**
   * The first candidate that actually decodes, or '' while none has been proven.
   *
   * The chain is walked with off-screen probes rather than by cascading the
   * displayed `<img>` through its own `onerror`: that `<img>` is a single element
   * reused across every candidate, so a failure event already queued for one src
   * still fires after the next has been assigned, and advancing on it skips the
   * candidate now on screen. That is what made an icon appear and then be
   * replaced by the globe a moment later - the chain is rebuilt when the preview
   * payload arrives with the site's declared icon, and the stale error from the
   * conventional path tried meanwhile walked straight past it. A probe owns its
   * own element, so an answer can only ever be about the URL that was asked.
   */
  let faviconUrl = $state('');
  /** False while candidates are still being probed: the globe waits for a verdict. */
  let faviconSearchDone = $state(false);
  $effect(() => {
    const chain = faviconChain;
    let cancelled = false;
    faviconUrl = '';
    faviconSearchDone = false;

    void (async () => {
      for (const candidate of chain) {
        const ok = await loadsAsImage(candidate);
        if (cancelled) return;
        if (ok) {
          faviconUrl = candidate;
          faviconSearchDone = true;
          return;
        }
      }
      faviconSearchDone = true;
    })();

    return () => {
      cancelled = true;
    };
  });

  /**
   * A REEL'S CARD OPENS THE REEL, NOT ITS PAGE (user, 2026-10-23, sharing lot S6), through
   * `SharedReelViewer` - the one opener this card and the chat's `SharedPostCard` share. A tap
   * before the card has read its post still opens the page: the card does not yet know it is a reel.
   */
  let openReel = $state<NonNullable<CanariLinkPreview['reelPost']> | null>(null);

  async function handleClick(e: MouseEvent) {
    e.stopPropagation();
    if (isInApp) {
      e.preventDefault();
      const reel = canariPreview?.reelPost;
      if (reel) {
        openReel = reel;
        return;
      }
      await navigateInAppFromHref(url);
      return;
    }

    // `openExternal` carries its own Safe Browsing gate (WP-SAFELINK-1). Only a plain left-click
    // is intercepted - a modified click (new tab/window) goes through the browser's own handling.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    await openExternal(parsed.href);
  }
</script>

<!-- The tile: the in-app target's picture or the Canari logo; an album's square cover; a page's
     Open Graph picture, else its favicon, else a globe. -->
{#snippet tile()}
  {#if isInApp}
    <CanariLinkPreviewMedia preview={canariPreview} loading={isPending} />
  {:else if coverCard && coverLoads}
    <img src={coverUrl} alt="" class="absolute inset-0 h-full w-full object-cover" loading="lazy" />
  {:else if isPending}
    <div class="absolute inset-0 animate-pulse bg-black/10 dark:bg-white/10"></div>
  {:else if coverCard}
    <Images size={24} strokeWidth={2} />
  {:else if showsPreviewImage}
    <img
      src={previewImageUrl}
      alt=""
      class="absolute inset-0 h-full w-full object-cover"
      loading="lazy"
    />
  {:else if faviconUrl}
    <!-- No Open Graph image: the site's own favicon stands in for its logo.
         Already proven loadable by the probe above, so it needs no onerror. -->
    <img src={faviconUrl} alt="" class="h-8 w-8 object-contain opacity-70" />
  {:else if faviconSearchDone}
    <Globe size={24} strokeWidth={2} />
  {/if}
{/snippet}

<!-- The hero's picture: an album's cover, a page's Open Graph picture, or a post's own photo. -->
{#snippet banner()}
  {#if isInApp && canariPreview?.postImage && postImageAuthToken && PostMedia}
    <div class="relative h-64 w-full">
      <PostMedia media={canariPreview.postImage} authToken={postImageAuthToken} letterbox />
    </div>
  {:else}
    <img
      src={bannerUrl}
      alt=""
      class="aspect-[1.91/1] w-full bg-black/5 object-cover dark:bg-white/5"
      loading="lazy"
    />
  {/if}
{/snippet}

<!-- THE POST'S OWN PHOTO, below the row in the compact card: the tile stays the association's mark
     (or the brand, for a personal post). LETTERBOXED, like the post this is a preview OF - an A4
     poster cropped to a band loses the date, the place and the price. -->
{#snippet postImage()}
  {#if canariPreview?.postImage && PostMedia}
    <div class="relative h-56 w-full sm:h-64">
      <PostMedia media={canariPreview.postImage} authToken={postImageAuthToken} letterbox />
    </div>
  {/if}
{/snippet}

<AttachmentCard
  kind="link"
  href={isInApp ? (inAppPath ?? '#') : parsed.href}
  external={!isInApp}
  onclick={handleClick}
  onnear={() => (isNear = true)}
  chip={cardCategory}
  title={cardTitle}
  subtitle={cardSubtitle}
  pending={isPending && (isInApp || Boolean(coverCard))}
  {tile}
  {hero}
  banner={hasBanner ? banner : undefined}
  heroAction={canariPreview?.kind === 'form' ? m.post_form_fill_label() : undefined}
  below={hasPostImage && !hero ? postImage : undefined}
  class={standalone ? '' : 'mt-3'}
/>

<SharedReelViewer reel={openReel} logTag="LINK_PREVIEW" onClose={() => (openReel = null)} />
