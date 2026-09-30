import type { Component } from 'svelte';
import {
  createComponent,
  onComponentEvent,
  removeComponent,
  updateComponent,
  type ComponentProps,
  type CreateComponentOptions,
} from '@sosweetham/tauri-plugin-system-components-api';
import type { GlassMenuItem } from '$lib/components/shared/GlassMenuButton.svelte';
import { screenCover } from '$lib/actions/coversScreen.svelte';
import { renderedAvatarPng } from '$lib/mobile/avatarBitmap';
import { classColorHex, lucideIconPng } from '$lib/mobile/nativeTabIcons';
import { themeStore } from '$lib/stores/themeStore.svelte';
import { isIosTauriRuntime } from '$lib/utils/appVersion';
import { Log } from '$lib/utils/Log';

/**
 * THE CONVERSATION'S GLASS CHROME AS REAL LIQUID GLASS, ON iOS (WP-G2, user, 2026-09-30).
 *
 * WP-G1 draws the phone apps' header pieces and the composer's "+" in CSS glass. On iOS each of them
 * is doubled by a NATIVE button of the patched `tauri-plugin-system-components` - a UIButton in the
 * glass configuration, which refracts the thread scrolling under it where CSS can only blur it - and
 * the web piece stays in the page, laid out but invisible, as the native one's GEOMETRY. So the web
 * layout keeps deciding where every piece is, at every width and keyboard height, and the native
 * layer only follows the rect it is given: one owner of the layout, not two.
 *
 * A menu is a native UIMenu that iOS 26 grows out of its glass button, which is the Liquid Glass
 * gesture the CSS panel imitates. A pick calls the web entry's `onSelect` SYNCHRONOUSLY in the event
 * handler, which is what lets "Photos" open a file input from a native tap: the plugin's events
 * arrive through `evaluateJavaScript`, which WebKit runs as a user gesture.
 *
 * NO WEB LAYER CAN COVER A NATIVE VIEW, so a piece hides while anything covers the screen
 * ({@link screenCover}, the rule the native tab bar follows) and while its web twin has no box (the
 * phone header is `md:hidden`). A failed setup leaves the web piece visible and says so at error
 * level: the CSS glass is the design on a build that was meant to have the native one.
 */

/** Only the iOS app draws native glass; Android keeps WP-G1's CSS glass. */
export function usesNativeGlassChrome(): boolean {
  return isIosTauriRuntime();
}

/** What one native piece shows, and what a tap on it does. */
export interface NativeGlassPieceParams {
  /** Stable name of the piece; made unique per mount, since two composers may be mounted. */
  id: string;
  /** VoiceOver's name for the piece. */
  label: string;
  /** The glyph of an icon-only button (back, "more", "+"). */
  icon?: Component<Record<string, unknown>>;
  /** A visible title - the conversation's name, in the centre pill. */
  title?: string;
  /**
   * Rasterise the avatar the web draws inside the node (`[data-glass-avatar]`) as the button's
   * round image - the pill shows the same picture, initials or icon as the web one.
   */
  avatar?: boolean;
  /** Set, the button opens these entries natively instead of reporting a click. */
  items?: GlassMenuItem[];
  onClick?: () => void;
}

/** The chrome's glyph and title colour: the theme's text colour, like every web piece. */
const FOREGROUND_CLASS = 'text-text-main';
/** The pill's avatar, in points: the web pill's `h-8` avatar. */
const AVATAR_POINTS = 28;

interface Handlers {
  click: () => void;
  menu: (entryId: string) => void;
}

/** Every mounted piece's handlers, by native id - ONE plugin listener dispatches to all of them. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- read by the event listener only, never by an effect or a template
const handlers = new Map<string, Handlers>();
let listening: Promise<unknown> | null = null;
let mounted = 0;

function listenOnce(): Promise<unknown> {
  listening ??= onComponentEvent(({ id, event, detail }) => {
    const handler = handlers.get(id);
    if (!handler) {
      Log.d('nativeGlassPiece', `event ${event} for an unmounted piece ${id}`);
      return;
    }
    // `menu` is the Canari patch's event (a button's entries), unknown to the package's types.
    if ((event as string) === 'menu' && detail) handler.menu(detail);
    else if (event === 'click') handler.click();
  });
  return listening;
}

/** The patched props (`patches/tauri-plugin-system-components`, `ComponentProps` in models.rs). */
interface PatchedProps extends ComponentProps {
  menu?: { id: string; title: string; image?: string; on?: boolean }[];
  hidden?: boolean;
  accessibilityLabel?: string;
  foreground?: string;
  imageSide?: number;
}

/** A glyph rasterised once per colour - the menus redraw on every open-state change. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a cache of promises, never read reactively
const glyphs = new Map<Component<Record<string, unknown>>, Map<string, Promise<string>>>();
function glyphPng(icon: Component<Record<string, unknown>>, colorHex: string): Promise<string> {
  let byColour = glyphs.get(icon);
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- part of the cache above
  if (!byColour) glyphs.set(icon, (byColour = new Map()));
  let png = byColour.get(colorHex);
  if (!png) byColour.set(colorHex, (png = lucideIconPng(icon, colorHex)));
  return png;
}

/**
 * Svelte action: doubles `node` with a native glass button on iOS, and does nothing elsewhere.
 * Put it on the web piece's own box - its rect is where the native piece is drawn.
 */
export function nativeGlassPiece(node: HTMLElement, initial: NativeGlassPieceParams) {
  if (!usesNativeGlassChrome()) return {};

  const nativeId = `${initial.id}-${++mounted}`;
  let params = $state.raw(initial);
  /** Bumped when the rasterised avatar may have changed (a photo loaded, an initial changed). */
  let avatarVersion = $state(0);
  let covered = $state(screenCover.covered);
  let rect = $state.raw(measure());
  let status: 'pending' | 'native' | 'failed' | 'destroyed' = 'pending';
  /** Every call to the plugin, in order: an update must never overtake the creation. */
  let queue: Promise<unknown> = Promise.resolve();

  function measure() {
    const box = node.getBoundingClientRect();
    return { x: box.left, y: box.top, width: box.width, height: box.height };
  }

  function enqueue(what: string, call: () => Promise<unknown>) {
    queue = queue.then(call).catch((e: unknown) => {
      if (status === 'pending') {
        status = 'failed';
        node.style.visibility = '';
        console.error(
          `[nativeGlassPiece] ${nativeId} could not be created - the CSS glass stays:`,
          e
        );
        return;
      }
      console.warn(`[nativeGlassPiece] ${nativeId} ${what} failed:`, e);
    });
  }

  handlers.set(nativeId, {
    click: () => params.onClick?.(),
    menu: (entryId) => {
      const entry = params.items?.find((item) => item.id === entryId);
      Log.d('nativeGlassPiece', `${nativeId} menu: ${entryId}`);
      entry?.onSelect();
    },
  });

  /** Everything the piece DRAWS - redrawn when the params, the theme or the avatar change. */
  async function appearance(p: NativeGlassPieceParams): Promise<PatchedProps> {
    const foreground = classColorHex(FOREGROUND_CLASS);
    const avatarNode = p.avatar ? node.querySelector<HTMLElement>('[data-glass-avatar]') : null;
    const image = avatarNode
      ? ((await renderedAvatarPng(avatarNode)) ?? undefined)
      : p.icon
        ? await glyphPng(p.icon, foreground)
        : undefined;
    const menu = p.items
      ? await Promise.all(
          p.items.map(async (item) => ({
            id: item.id,
            title: item.label,
            image: await glyphPng(item.icon, foreground),
            ...(item.active === undefined ? {} : { on: item.active }),
          }))
        )
      : undefined;
    return {
      label: p.title,
      accessibilityLabel: p.label,
      image,
      circular: avatarNode ? true : undefined,
      imageSide: avatarNode ? AVATAR_POINTS : undefined,
      foreground,
      menu,
    };
  }

  const geometry = () => {
    const r = rect;
    return { ...r, hidden: covered || r.width === 0 || r.height === 0 };
  };

  /**
   * EVERY EFFECT ENQUEUES AND EVERY TASK READS THE STATUS WHEN IT RUNS - so a change made while
   * the creation is in flight is applied after it rather than lost, and nothing reaches a piece
   * that failed or was unmounted.
   */
  let createQueued = false;
  let created = false;
  const stopEffects = $effect.root(() => {
    // What the piece draws. The first run CREATES it, every later one redraws it in place.
    $effect(() => {
      const p = params;
      void themeStore.isDark;
      void avatarVersion;
      if (!createQueued) {
        createQueued = true;
        enqueue('create', async () => {
          await listenOnce();
          const options: CreateComponentOptions = {
            id: nativeId,
            kind: 'button',
            anchor: 'absolute',
            props: { ...(await appearance(p)), ...geometry() } as ComponentProps,
          };
          await createComponent(options);
          created = true;
          if (status !== 'pending') return;
          status = 'native';
          node.style.visibility = 'hidden';
          Log.d('nativeGlassPiece', `${nativeId} native`);
        });
        return;
      }
      enqueue('redraw', async () => {
        if (status === 'native') await updateComponent(nativeId, await appearance(p));
      });
    });
    // Where it is, and whether it shows.
    $effect(() => {
      const g = geometry();
      enqueue('move', async () => {
        if (status === 'native') await updateComponent(nativeId, g as ComponentProps);
      });
    });
    // The cover follows the shared set of covering surfaces.
    $effect(() => {
      covered = screenCover.covered;
    });
  });

  const remeasure = () => {
    const next = measure();
    const r = rect;
    if (next.x === r.x && next.y === r.y && next.width === r.width && next.height === r.height)
      return;
    rect = next;
  };
  const resizes = new ResizeObserver(remeasure);
  resizes.observe(node);
  window.addEventListener('resize', remeasure);
  window.visualViewport?.addEventListener('resize', remeasure);

  // A photo that loads, an initial or a presence dot that changes: the pill's picture is redrawn.
  // The whole node is watched, since the avatar itself is swapped when the conversation's kind
  // changes - but not the node's OWN attributes, which this action writes (`visibility`).
  const avatarChanges = new MutationObserver((records) => {
    if (records.some((r) => r.target !== node)) avatarVersion++;
  });
  const onAvatarLoad = () => avatarVersion++;
  if (initial.avatar) {
    avatarChanges.observe(node, { childList: true, subtree: true, attributes: true });
    node.addEventListener('load', onAvatarLoad, true);
  }

  return {
    update(next: NativeGlassPieceParams) {
      params = next;
      remeasure();
    },
    destroy() {
      status = 'destroyed';
      stopEffects();
      resizes.disconnect();
      avatarChanges.disconnect();
      node.removeEventListener('load', onAvatarLoad, true);
      window.removeEventListener('resize', remeasure);
      window.visualViewport?.removeEventListener('resize', remeasure);
      handlers.delete(nativeId);
      node.style.visibility = '';
      // Queued behind a creation still in flight, so a piece created after its unmount is removed.
      enqueue('remove', async () => {
        if (created) await removeComponent(nativeId);
      });
    },
  };
}
