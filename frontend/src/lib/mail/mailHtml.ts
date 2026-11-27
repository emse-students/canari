import { Log } from '$lib/utils/Log';

/**
 * AN HTML MAIL, MADE INTO THE DOCUMENT OF A SANDBOXED FRAME (docs/wiki/mail-client.md D9).
 *
 * Mail HTML is written by strangers, so it is shown in an `<iframe sandbox srcdoc>` that grants
 * neither `allow-scripts` nor `allow-same-origin` (`MailHtmlFrame.svelte`): nothing in it runs, and
 * it cannot reach the app's origin, its storage or its cookies. This module writes that frame's
 * document, in layers - none of them trusted alone:
 *
 * 1. **The sandbox** is the wall: no script, form, plugin or top navigation runs, whatever survives
 *    below.
 * 2. **A Content-Security-Policy** `<meta>` blocks every remote load: `default-src 'none'`, images
 *    from `data:` only (the inline `cid:` images, resolved by the reader into data URLs), styles
 *    inline only, fonts from `data:`. "Afficher les images" adds `https:` to `img-src` for THAT
 *    message, and nothing else. A frame's `srcdoc` also inherits the app's own policy, so this one
 *    can only narrow it.
 * 3. **A cleaning pass** over an inert parse (`DOMParser` runs nothing): scripts, frames, plugins,
 *    forms and `<base>`/`<meta>`/`<link>` removed, every `on*` handler removed, a link kept only to
 *    `https:`, `http:` or `mailto:`, opening outside (`target="_blank"`, `noopener noreferrer`).
 *    Zimbra has already defanged the body (remote images moved to `dfsrc`); that is a first layer
 *    only, and this pass does not rely on it.
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

/** A link the frame may keep: the web and mail addresses, nothing that runs or embeds. */
const SAFE_LINK = /^(https?:|mailto:)/i;
/** An image source that loads from the network. */
const REMOTE = /^(https?:)?\/\//i;

/** The policy of the frame's document: nothing remote, unless the reader allowed its images. */
export function mailFramePolicy(showRemoteImages: boolean): string {
  const images = showRemoteImages ? 'data: https:' : 'data:';
  return [
    "default-src 'none'",
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

/** How many remote images `html` asks for (`img` sources and backgrounds, defanged or not). */
export function remoteImageCount(html: string): number {
  const doc = parse(html);
  let count = 0;
  for (const el of doc.querySelectorAll('*')) {
    const source =
      el.tagName === 'IMG' ? sourceOf(el, IMAGE_SOURCES) : sourceOf(el, BACKGROUND_SOURCES);
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
    return source.startsWith('//') ? `https:${source}` : source;
  }
  return /^data:image\//i.test(source) ? source : null;
}

/**
 * The document of the sandboxed frame for the mail body `html`: cleaned, its images resolved under
 * `options`, its policy and its link target in a head of our own.
 */
export function mailFrameDocument(html: string, options: MailFrameOptions): string {
  const doc = parse(html);
  let removed = 0;
  for (const el of doc.querySelectorAll(REMOVED_ELEMENTS.join(','))) {
    el.remove();
    removed++;
  }
  let handlers = 0;
  for (const el of doc.querySelectorAll('*')) {
    // A copy: removing from the live NamedNodeMap while walking it would skip the next attribute.
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        el.removeAttribute(attr.name);
        handlers++;
      }
    }
    if (el.tagName === 'IMG') {
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
    if (el.tagName === 'A' || el.tagName === 'AREA') {
      const href = el.getAttribute('href')?.trim() ?? '';
      if (SAFE_LINK.test(href)) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      } else {
        el.removeAttribute('href');
      }
    }
    // An SVG's own link attribute is a navigation the sandbox already refuses; it is dropped too.
    el.removeAttribute('xlink:href');
    el.removeAttribute('formaction');
  }
  if (removed || handlers) {
    Log.d('MAIL-HTML', `cleaned: ${removed} element(s), ${handlers} handler(s) removed`);
  }
  const head = doc.head;
  const policy = doc.createElement('meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute('content', mailFramePolicy(options.showRemoteImages));
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  const base = doc.createElement('base');
  base.setAttribute('target', '_blank');
  const style = doc.createElement('style');
  // The frame's own defaults: a mail is written for a light page (its colours assume one), so the
  // frame stays light in the app's dark theme, as every mail client draws it; no horizontal scroll
  // from a wide table.
  style.textContent =
    ':root{color-scheme:light}body{background:white;color:black}html,body{margin:0;padding:0;overflow-wrap:anywhere;font-family:system-ui,sans-serif;font-size:15px;line-height:1.5}img{max-width:100%;height:auto}table{max-width:100%}';
  head.prepend(charset, policy, base, style);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

/** `bytes` as a `data:` URL of `contentType` - an inline image the frame may show (`img-src data:`). */
export function bytesToDataUrl(bytes: Uint8Array, contentType: string): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const type = /^image\/[\w.+-]+$/i.test(contentType) ? contentType : 'application/octet-stream';
  return `data:${type};base64,${btoa(binary)}`;
}
