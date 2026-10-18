import sharp from 'sharp';

/**
 * THE `og:image` OF A SHARED POST, ALWAYS THE SAME SHAPE.
 *
 * The card used to be whatever bytes the post carried: a photo of any size, or the association's
 * 512x512 logo with no dimensions declared at all. Facebook and Messenger reserve the image box from
 * `og:image:width`/`height` and from the aspect ratio they find, and an undeclared square crest is
 * the shape they most often drop or render as a thumbnail - the intermittent Messenger preview
 * failure of 2026-10-18. A fixed 1200x630 (1.91:1, Facebook's own recommendation) JPEG makes the
 * declared numbers a fact the head can state without looking at the post.
 */
export const POST_CARD_WIDTH = 1200;
export const POST_CARD_HEIGHT = 630;
export const POST_CARD_CONTENT_TYPE = 'image/jpeg';

/** The brand ink (`--color-cn-ink`, frontend/src/app.css): the plain background behind a logo. */
export const POST_CARD_BACKGROUND = '#151b2c';

/** The longest side a logo may take on the card, leaving the background visible all around it. */
const LOGO_MAX_SIDE = 420;

const JPEG_QUALITY = 82;

/** What a card is built from. A post's photo wins; a logo is only used when there is no photo. */
export interface PostCardSource {
  photo?: Buffer | null;
  logo?: Buffer | null;
}

/**
 * Renders the 1200x630 card for one post.
 *
 * - a photo is cropped to cover the whole card (EXIF orientation applied first, so a phone photo
 *   is not rotated);
 * - otherwise a logo is fitted, uncropped, in the middle of a plain brand background;
 * - with neither, the plain background alone is still a card of the declared size.
 *
 * Carries no personal data by construction: it reads pixels only, and the JPEG is written without
 * metadata (sharp strips it unless asked to keep it), so the photo's EXIF - GPS included - is gone.
 *
 * Throws when sharp cannot decode the bytes; the caller decides what a failure means.
 */
export async function renderPostCard(source: PostCardSource): Promise<Buffer> {
  if (source.photo) {
    return sharp(source.photo)
      .rotate()
      .resize(POST_CARD_WIDTH, POST_CARD_HEIGHT, { fit: 'cover', position: 'attention' })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
  }

  const base = sharp({
    create: {
      width: POST_CARD_WIDTH,
      height: POST_CARD_HEIGHT,
      channels: 3,
      background: POST_CARD_BACKGROUND,
    },
  });
  if (!source.logo) return base.jpeg({ quality: JPEG_QUALITY }).toBuffer();

  const logo = await sharp(source.logo)
    .rotate()
    .resize(LOGO_MAX_SIDE, LOGO_MAX_SIDE, { fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer();
  return base
    .composite([{ input: logo, gravity: 'centre' }])
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}
