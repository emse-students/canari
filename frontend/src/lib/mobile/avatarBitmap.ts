import { Log } from '$lib/utils/Log';

/**
 * THE AVATAR THE WEB DRAWS, AS A BITMAP FOR A NATIVE BUTTON (WP-G2's centre pill).
 *
 * The native pill cannot host the web's `Avatar`, `GroupAvatar` or channel glyph, and redrawing
 * each of them natively would be a second copy of three components. So this reads the RENDERED
 * node and paints what it shows: the photo when one has loaded, the glyph when it is an icon, and
 * otherwise the initials on their own background - plus the presence dot when the web shows one.
 * The colours are the node's computed ones, so they are the design tokens of the current theme.
 */

/** The bitmap's side in CSS pixels (the web pill's `h-8` avatar), drawn at 3x like the tab icons. */
const SIDE = 32;
const SCALE = 3;

/**
 * The loaded photo inside `root`, if any - a still-loading or broken one draws nothing, and so does
 * one the page may not READ: the avatar cache hands the `<img>` an API URL itself when its own
 * fetch got no answer (`AvatarDisplay.direct`), and on the native apps that URL is another origin,
 * whose pixels would taint the canvas and make `toDataURL` throw.
 */
function loadedPhoto(root: HTMLElement): HTMLImageElement | null {
  const img = root.querySelector('img');
  if (!img || !img.complete || img.naturalWidth === 0) return null;
  if (!/^(blob|data):/.test(img.currentSrc || img.src)) {
    Log.d('avatarBitmap', 'the photo is not readable here (a direct URL) - drawn without it');
    return null;
  }
  return img;
}

/** An SVG as an image, with `currentColor` resolved - an SVG loaded as an image has no context. */
async function svgImage(svg: SVGSVGElement): Promise<HTMLImageElement> {
  const color = getComputedStyle(svg).color;
  const markup = svg.outerHTML.replaceAll('currentColor', color);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await image.decode();
  return image;
}

/** The deepest element in `root` carrying text - the initials' own box, with their colours. */
function initialsBox(root: HTMLElement): HTMLElement | null {
  const boxes = [root, ...root.querySelectorAll<HTMLElement>('*')].filter(
    (el) => el.children.length === 0 && (el.textContent ?? '').trim().length > 0
  );
  return boxes.at(-1) ?? null;
}

/**
 * `root` (the node the web avatar is drawn in) as a PNG data URL, or null when it shows nothing
 * yet. The circle is the pill's; a square photo is cropped to it like `object-cover`.
 */
export async function renderedAvatarPng(root: HTMLElement): Promise<string | null> {
  const side = SIDE * SCALE;
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas to rasterise an avatar');

  ctx.save();
  ctx.beginPath();
  ctx.arc(side / 2, side / 2, side / 2, 0, Math.PI * 2);
  ctx.clip();

  const photo = loadedPhoto(root);
  const svg = photo ? null : root.querySelector('svg');
  const initials = photo || svg ? null : initialsBox(root);
  if (photo) {
    const crop = Math.min(photo.naturalWidth, photo.naturalHeight);
    ctx.drawImage(
      photo,
      (photo.naturalWidth - crop) / 2,
      (photo.naturalHeight - crop) / 2,
      crop,
      crop,
      0,
      0,
      side,
      side
    );
  } else if (svg) {
    // A glyph (a channel's `#`) sits in the middle of the circle at the size the web gives it.
    const image = await svgImage(svg);
    const glyph = (svg.getBoundingClientRect().width || SIDE * 0.56) * SCALE;
    ctx.drawImage(image, (side - glyph) / 2, (side - glyph) / 2, glyph, glyph);
  } else if (initials) {
    const style = getComputedStyle(initials);
    ctx.fillStyle = style.backgroundColor;
    ctx.fillRect(0, 0, side, side);
    ctx.fillStyle = style.color;
    ctx.font = `${style.fontWeight} ${side * 0.42}px ${style.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((initials.textContent ?? '').trim(), side / 2, side / 2);
  } else {
    ctx.restore();
    Log.d('avatarBitmap', 'the avatar draws nothing yet');
    return null;
  }
  ctx.restore();

  // The presence dot, where the web draws it: bottom right, with a transparent gap around it so
  // the glass shows through - where the web draws that gap as a ring in the surface colour.
  const dot = root.querySelector<HTMLElement>('[data-presence-dot]');
  if (dot) {
    const radius = side * 0.16;
    const centre = side - radius * 1.25;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(centre, centre, radius + SCALE * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    ctx.arc(centre, centre, radius, 0, Math.PI * 2);
    ctx.fillStyle = getComputedStyle(dot).backgroundColor;
    ctx.fill();
  }
  return canvas.toDataURL('image/png');
}
