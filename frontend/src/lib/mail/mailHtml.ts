import { Log } from '$lib/utils/Log';
import { MAIL_FRAME_SCRIPT, MAIL_FRAME_SCRIPT_HASH } from '$lib/security/mailFrameScript.js';
import type { AttachmentRef } from './mailTypes';

/**
 * AN HTML MAIL, MADE INTO THE DOCUMENT OF A SANDBOXED FRAME (docs/wiki/mail-client-transport.md D9).
 *
 * Mail HTML is written by strangers, so it is shown in an `<iframe sandbox="allow-scripts" srcdoc>`
 * (`MailHtmlFrame.svelte`) whose origin is OPAQUE - never `allow-same-origin`: it cannot reach the
 * app's origin, its storage, its keys or its cookies. No popup, form or top navigation either. This
 * module writes that frame's document, in layers - none of them trusted alone:
 *
 * 1. **The sandbox**: an opaque origin with no navigation of any kind. `allow-scripts` is there for
 *    OUR one script (`mailFrameScript.js`: the height and the links, by `postMessage`).
 * 2. **A Content-Security-Policy** `<meta>`: `default-src 'none'`, `script-src` by our script's
 *    hash ONLY (a mail script revived past the pass is refused), images from `data:` only (the
 *    inline `cid:` images, resolved by the reader into data URLs), styles inline only, fonts from
 *    `data:`. "Afficher les images" adds `https:` to `img-src` for THAT message, and nothing else. A
 *    `srcdoc` frame also inherits the app's own policy, so this one can only narrow it.
 * 3. **A cleaning pass** over an inert parse (`DOMParser` runs nothing): scripts, frames, plugins,
 *    forms and `<base>`/`<meta>`/`<link>` removed, every `on*` handler and `ping` removed. EVERY
 *    `href` (any element, SVG's `<a>` and `xlink:href` included) is removed: a web or mail address
 *    (`SAFE_LINK`) on a link moves to `data-mail-href`, which our script hands to the app - nothing
 *    in the frame navigates. An SVG `<image>` keeps its source through the image rules. Viewport
 *    height units are turned into pixels, so a `min-height: 100vh` cannot grow with the frame it
 *    sizes. Zimbra has already defanged the body (remote images moved to `dfsrc`); that is a first
 *    layer only, and this pass does not rely on it.
 *
 * REMOTE IMAGES ARE BLOCKED BY DEFAULT (charter principle 3: a tracking pixel tells the sender the
 * mail was opened, when, and from where). {@link remoteImageCount} says how many a body asks for, so
 * the reader offers "Afficher les images" only when there are some.
 *
 * `cid:` images are resolved from THE MESSAGE'S OWN PARTS only (`inlineImages`, filled by the reader
 * from `AttachmentRef.contentId`): a `cid:` the message does not carry stays empty.
 */

/** What the frame's document is built with. */
export interface MailFrameOptions {
  /** The reader allowed this message's remote images ("Afficher les images"). */
  showRemoteImages: boolean;
  /** The message's own inline images: `Content-ID` (no angle brackets) to a `data:` URL. */
  inlineImages: ReadonlyMap<string, string>;
}

/** Elements removed whole, with what they hold. */
const REMOVED_ELEMENTS = [
  'script',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'meta',
  'link',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'template',
  'portal',
] as const;

/** The image attributes a mail may carry a source in (Zimbra's defanged ones included). */
const IMAGE_SOURCES = ['src', 'dfsrc', 'pnsrc'] as const;
/** The background attributes (a table cell's `background`, defanged `dfbackground`). */
const BACKGROUND_SOURCES = ['background', 'dfbackground'] as const;

/** A link the frame may hand to the app: the web and mail addresses, nothing that runs or embeds. */
const SAFE_LINK = /^(https?:|mailto:)/i;
/** An image source that loads from the network. */
const REMOTE = /^(https?:)?\/\//i;

/** The attribute a link's address moves to: inert in the frame, read by its one script. */
export const MAIL_LINK_ATTRIBUTE = 'data-mail-href';

/**
 * Whether `href` is an address the reader may be sent to from a mail: `https:`, `http:`, `mailto:`.
 * The cleaning pass keeps only these, and the frame's parent checks a pressed link against it again.
 */
export function isSafeMailLink(href: string): boolean {
  return SAFE_LINK.test(href.trim());
}

/** The largest inline image drawn in the body; a bigger part is listed as an attachment instead. */
export const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The media type of a `Content-Type` value, without its parameters, in lower case
 * (`Image/PNG; name="a.png"` -> `image/png`).
 */
export function mediaTypeOf(contentType: string): string {
  return contentType.split(';')[0].trim().toLowerCase();
}

/** Whether a `Content-Type` value names an image (`image/<subtype>`, its parameters ignored). */
export function isImageMediaType(contentType: string): boolean {
  return /^image\/[\w.+-]+$/.test(mediaTypeOf(contentType));
}

/**
 * Whether `part` is drawn INSIDE the body (resolved for its `cid:`) rather than listed as an
 * attachment: an inline image with a `Content-ID`, no larger than {@link INLINE_IMAGE_MAX_BYTES}.
 * The reader lists every other part, so a part is always either drawn or downloadable.
 */
export function isInlineImagePart(part: AttachmentRef): boolean {
  return (
    part.inline &&
    part.contentId !== null &&
    isImageMediaType(part.contentType) &&
    part.size <= INLINE_IMAGE_MAX_BYTES
  );
}

/** The pixels one viewport-height unit stands for in a mail (a reference viewport of 800 px). */
const VIEWPORT_UNIT_PX = 8;
/** A length in a viewport unit tied to the height (`vh` and its variants, `vmin`, `vmax`). */
const VIEWPORT_LENGTH = /(-?\d*\.?\d+)(dvh|svh|lvh|vh|vmin|vmax)\b/gi;

/**
 * `css` with its viewport-height lengths turned into pixels. The frame is sized FROM its document,
 * so a length that follows the frame's height (`min-height: 100vh`, `height: 150vh`) would make the
 * two chase each other; a pixel length does not. Widths (`vw`) follow the reader's screen and stay.
 */
export function neutraliseViewportUnits(css: string): string {
  return css.replace(VIEWPORT_LENGTH, (_, value: string) => {
    const px = Math.round(Number(value) * VIEWPORT_UNIT_PX * 100) / 100;
    return `${px}px`;
  });
}

/** The policy of the frame's document: nothing remote, unless the reader allowed its images. */
export function mailFramePolicy(showRemoteImages: boolean): string {
  const images = showRemoteImages ? 'data: https:' : 'data:';
  return [
    "default-src 'none'",
    `script-src '${MAIL_FRAME_SCRIPT_HASH}'`,
    `img-src ${images}`,
    "style-src 'unsafe-inline'",
    'font-src data:',
    "form-action 'none'",
  ].join('; ');
}

/** The `cid:` id of a source (`cid:abc@x` -> `abc@x`), or `null`. */
function cidOf(source: string): string | null {
  const match = /^cid:(.+)$/i.exec(source.trim());
  return match ? decodeURIComponent(match[1]).replace(/^<|>$/g, '') : null;
}

/** Parses `html` into an inert document (nothing in it runs or loads). */
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** The first image source an element carries, among {@link IMAGE_SOURCES} / backgrounds. */
function sourceOf(el: Element, names: readonly string[]): string | null {
  for (const name of names) {
    const value = el.getAttribute(name);
    if (value && value.trim()) return value.trim();
  }
  return null;
}

/** The address an element carries in an `href` of any namespace (`href`, `xlink:href`), or `null`. */
function hrefOf(el: Element): string | null {
  for (const attr of Array.from(el.attributes)) {
    if (attr.localName === 'href' && attr.value.trim()) return attr.value.trim();
  }
  return null;
}

/** The image source of an element: an `img`'s, an SVG `image`'s `href`, or a background. */
function imageSourceOf(el: Element): string | null {
  if (el.localName === 'img') return sourceOf(el, IMAGE_SOURCES);
  if (el.localName === 'image') return hrefOf(el);
  return sourceOf(el, BACKGROUND_SOURCES);
}

/**
 * How many remote images `html` asks for (`img` sources, SVG images and backgrounds, defanged or
 * not; an `http:` one counts, as it is shown upgraded to `https:`).
 */
export function remoteImageCount(html: string): number {
  const doc = parse(html);
  let count = 0;
  for (const el of doc.querySelectorAll('*')) {
    const source = imageSourceOf(el);
    if (source && REMOTE.test(source)) count++;
  }
  return count;
}

/**
 * Rewrites one image source: a `cid:` to the message's own part (or nothing), a remote one to
 * itself when allowed (or nothing), anything else (a `data:` URL) kept as it is.
 */
function resolveSource(source: string, options: MailFrameOptions): string | null {
  const cid = cidOf(source);
  if (cid !== null) return options.inlineImages.get(cid) ?? null;
  if (REMOTE.test(source)) {
    if (!options.showRemoteImages) return null;
    // Only `https:` is allowed by the frame's policy: a plain-HTTP image is fetched upgraded, never
    // in the clear (the reader's address and the mail's open time, readable on the path).
    return source.replace(/^(https?:)?\/\//i, 'https://');
  }
  const data = /^data:([^;,]*)/i.exec(source);
  return data && isImageMediaType(data[1]) ? source : null;
}

/**
 * One element's links and image sources: every `href` of any namespace removed; an SVG `image`'s
 * source resolved; a link's safe address moved to {@link MAIL_LINK_ATTRIBUTE} (focusable, named a
 * link), any other address dropped. Returns whether a link was kept.
 */
function cleanLinks(el: Element, options: MailFrameOptions): boolean {
  const href = hrefOf(el);
  for (const attr of Array.from(el.attributes)) {
    if (attr.localName === 'href') el.removeAttributeNode(attr);
  }
  el.removeAttribute(MAIL_LINK_ATTRIBUTE);
  if (href === null) return false;
  if (el.localName === 'image') {
    const resolved = resolveSource(href, options);
    if (resolved) el.setAttribute('href', resolved);
    return false;
  }
  if ((el.localName === 'a' || el.localName === 'area') && isSafeMailLink(href)) {
    el.setAttribute(MAIL_LINK_ATTRIBUTE, href);
    el.setAttribute('role', 'link');
    el.setAttribute('tabindex', '0');
    return true;
  }
  return false;
}

/**
 * The document of the sandboxed frame for the mail body `html`: cleaned, its images resolved under
 * `options`, its policy, its defaults and its one script in a head of our own.
 */
export function mailFrameDocument(html: string, options: MailFrameOptions): string {
  const doc = parse(html);
  let removed = 0;
  for (const el of doc.querySelectorAll(REMOVED_ELEMENTS.join(','))) {
    el.remove();
    removed++;
  }
  let handlers = 0;
  let links = 0;
  for (const el of doc.querySelectorAll('*')) {
    // A copy: removing from the live NamedNodeMap while walking it would skip the next attribute.
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        el.removeAttribute(attr.name);
        handlers++;
      }
    }
    el.removeAttribute('ping');
    el.removeAttribute('target');
    if (el.localName === 'img') {
      const source = sourceOf(el, IMAGE_SOURCES);
      for (const name of IMAGE_SOURCES) el.removeAttribute(name);
      el.removeAttribute('srcset');
      const resolved = source ? resolveSource(source, options) : null;
      if (resolved) el.setAttribute('src', resolved);
    }
    const background = sourceOf(el, BACKGROUND_SOURCES);
    if (background !== null) {
      for (const name of BACKGROUND_SOURCES) el.removeAttribute(name);
      const resolved = resolveSource(background, options);
      if (resolved) el.setAttribute('background', resolved);
    }
    if (cleanLinks(el, options)) links++;
    el.removeAttribute('formaction');
    const style = el.getAttribute('style');
    if (style) el.setAttribute('style', neutraliseViewportUnits(style));
  }
  for (const sheet of doc.querySelectorAll('style')) {
    sheet.textContent = neutraliseViewportUnits(sheet.textContent ?? '');
  }
  if (removed || handlers) {
    Log.d('MAIL-HTML', `cleaned: ${removed} element(s), ${handlers} handler(s) removed`);
  }
  Log.d('MAIL-HTML', `frame document: ${links} link(s) handed to the app`);
  const head = doc.head;
  const policy = doc.createElement('meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute('content', mailFramePolicy(options.showRemoteImages));
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  const style = doc.createElement('style');
  // The frame's own defaults. LITERAL VALUES, NOT THE APP'S TOKENS, ON PURPOSE: the frame is another
  // document (an opaque origin), so `app.css` and its custom properties never reach it - and a mail
  // is written for a light page (its colours assume one), so it stays light in the app's dark theme,
  // as every mail client draws it. A link made inert (`data-mail-href`) keeps the look of a link.
  style.textContent =
    ':root{color-scheme:light}body{background:white;color:black}html,body{margin:0;padding:0;overflow-wrap:anywhere;font-family:system-ui,sans-serif;font-size:15px;line-height:1.5}img{max-width:100%;height:auto}table{max-width:100%}[data-mail-href]{color:#1a56db;text-decoration:underline;cursor:pointer}';
  head.prepend(charset, policy, style);
  // OUR one script, last in the body so the body exists when it measures; allowed by its hash.
  const script = doc.createElement('script');
  script.textContent = MAIL_FRAME_SCRIPT;
  doc.body.append(script);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

/** `bytes` as a `data:` URL of `contentType` - an inline image the frame may show (`img-src data:`). */
export function bytesToDataUrl(bytes: Uint8Array, contentType: string): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const type = isImageMediaType(contentType)
    ? mediaTypeOf(contentType)
    : 'application/octet-stream';
  return `data:${type};base64,${btoa(binary)}`;
}
