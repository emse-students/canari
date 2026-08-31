import { formatTabTitle } from '$lib/utils/tabTitle';

/**
 * THE ONE WRITER OF `document.title` AND OF THE PAGE'S ICON LINKS.
 *
 * There were already two candidates and they could not both be right: `SeoHead` renders the route's
 * `<title>` reactively, and `useNotifications` used to save the current title, blink a bell over it
 * and restore what it had saved. An unread prefix added by a third party would have been captured by
 * that save and reinstated after the call ended, or erased by the next navigation - so the fix is
 * not a third writer but a single one, which is this module.
 *
 * HOW IT STAYS IN STEP WITH THE ROUTE. The page's own title is not passed in; it is OBSERVED. A
 * `MutationObserver` on the `<title>` element adopts every change that this module did not make as
 * the new base, so a navigation, a locale switch or any future title source is picked up without
 * knowing about them. Writes made here are recognised by comparing against what was last written -
 * which is why the render is a pure function of (base, unread, bell) and never an edit of the
 * current value: an accumulating prefix could not be told apart from someone else's title.
 */

/** The unread dot's colour, the same `bg-red-500` the in-app nav badge is painted with. */
const BADGE_COLOR = '#ef4444';

/** Side of the square canvas the badged icon is drawn on. 64 covers every tab-strip density. */
const ICON_SIZE = 64;

/** The route's own title, as last seen in the DOM. */
let baseTitle = '';
/** What this module last wrote, so the observer can tell our own write from someone else's. */
let lastWritten: string | null = null;
/** Total unread messages, as last published by the layout. */
let unread = 0;
/** Whether an incoming call is ringing. Owns the blink below. */
let ringing = false;
/** Current phase of the ring blink; meaningless while `ringing` is false. */
let bellOn = false;
let blinkTimer: ReturnType<typeof setInterval> | null = null;
let titleObserver: MutationObserver | null = null;

/** The icon links `app.html` declares, held while the badged one stands in for them. */
let displacedIcons: HTMLLinkElement[] | null = null;
/** The badged icon's data URL, drawn at most once per page load. */
let badgedIconHref: string | null = null;
/** In-flight draw, so a burst of messages cannot start several. */
let badgedIconPending: Promise<string | null> | null = null;

const BLINK_MS = 800;

function iconLinks(): HTMLLinkElement[] {
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')].filter(
    (l) => l.id !== 'canari-tab-badge'
  );
}

/**
 * Draws the app icon with an unread dot in its corner and returns it as a data URL.
 *
 * A DOT, NOT A NUMBER, and for the same reason the in-app nav badge is one: the count is already in
 * the title, where it is legible, and a favicon redrawn on every arriving message is a race between
 * asynchronous draws for a glyph that is sixteen pixels wide. One draw, cached for the page's life.
 *
 * Returns `null` when the icon cannot be read - and says so, because a silent failure here looks
 * exactly like an unread state that never arrived.
 */
async function drawBadgedIcon(): Promise<string | null> {
  const source = iconLinks().find((l) => l.type !== 'image/svg+xml') ?? iconLinks()[0];
  if (!source) {
    console.warn('[TabIndicator] no icon link in the document - no favicon badge');
    return null;
  }
  try {
    const img = new Image();
    img.src = source.href;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      console.warn('[TabIndicator] no 2d canvas context - no favicon badge');
      return null;
    }
    ctx.drawImage(img, 0, 0, ICON_SIZE, ICON_SIZE);
    const r = ICON_SIZE * 0.28;
    ctx.beginPath();
    ctx.arc(ICON_SIZE - r, r, r, 0, Math.PI * 2);
    ctx.fillStyle = BADGE_COLOR;
    ctx.fill();
    return canvas.toDataURL('image/png');
  } catch (e: unknown) {
    console.warn(
      `[TabIndicator] could not draw the favicon badge from ${source.href}: ${String(e).slice(0, 200)}`
    );
    return null;
  }
}

/** Installs the badged icon, displacing the declared ones so the browser cannot prefer them. */
function showBadgedIcon(href: string): void {
  if (displacedIcons) return;
  displacedIcons = iconLinks();
  for (const l of displacedIcons) l.remove();
  const link = document.createElement('link');
  link.id = 'canari-tab-badge';
  link.rel = 'icon';
  link.type = 'image/png';
  link.href = href;
  document.head.appendChild(link);
}

/** Puts the declared icons back, node for node - no attribute is edited, so none can be lost. */
function hideBadgedIcon(): void {
  document.getElementById('canari-tab-badge')?.remove();
  if (!displacedIcons) return;
  for (const l of displacedIcons) document.head.appendChild(l);
  displacedIcons = null;
}

function applyIcon(): void {
  if (unread <= 0) {
    hideBadgedIcon();
    return;
  }
  if (badgedIconHref) {
    showBadgedIcon(badgedIconHref);
    return;
  }
  badgedIconPending ??= drawBadgedIcon();
  void badgedIconPending.then((href) => {
    badgedIconHref = href;
    // Re-read the live count rather than the one this draw started for: it may have been cleared
    // while the icon was decoding, and installing a badge then would outlive its reason.
    if (href && unread > 0) showBadgedIcon(href);
  });
}

function apply(): void {
  if (typeof document === 'undefined') return;
  const next = formatTabTitle(baseTitle, unread, ringing && bellOn);
  if (next === document.title) return;
  lastWritten = next;
  document.title = next;
}

/**
 * Starts observing the document title and applying the indicator. Idempotent.
 *
 * Called once from the root layout. Nothing here runs on the server: the whole mechanism is about
 * what a browser tab shows.
 */
export function startTabIndicator(): void {
  if (typeof document === 'undefined' || titleObserver) return;
  baseTitle = document.title;
  const el = document.querySelector('title');
  if (!el) {
    console.warn('[TabIndicator] the document has no <title> element - unread stays off the tab');
    return;
  }
  titleObserver = new MutationObserver(() => {
    if (document.title === lastWritten) return;
    // Somebody else wrote the title - a navigation, a locale change - so that IS the new base.
    baseTitle = document.title;
    apply();
  });
  titleObserver.observe(el, { childList: true, characterData: true, subtree: true });
  apply();
}

/** Publishes the unread total. Cheap enough to call on every change; a no-op when it has not moved. */
export function setTabUnread(total: number): void {
  const next = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  if (next === unread) return;
  unread = next;
  apply();
  applyIcon();
}

/**
 * Announces an incoming call on the tab, or stops announcing one.
 *
 * The blink lives here rather than in the caller because the title has one writer; `useNotifications`
 * used to run its own timer over a saved copy of the title, which is what made a second writer
 * unsafe. A blink is a display animation, not a mechanism whose correctness a clock decides.
 */
export function setTabRinging(next: boolean): void {
  if (next === ringing) return;
  ringing = next;
  if (blinkTimer !== null) {
    clearInterval(blinkTimer);
    blinkTimer = null;
  }
  bellOn = next;
  if (next) {
    blinkTimer = setInterval(() => {
      bellOn = !bellOn;
      apply();
    }, BLINK_MS);
  }
  apply();
}
