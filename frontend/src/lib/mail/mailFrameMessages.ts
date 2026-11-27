import { isSafeMailLink } from './mailHtml';

/**
 * WHAT AN HTML MAIL'S FRAME MAY TELL ITS PARENT (D9; the frame's one script is
 * `security/mailFrameScript.js`).
 *
 * The frame is an opaque origin running a mail written by a stranger, so what arrives from it is
 * READ, never trusted: the component accepts a message only from ITS frame's window
 * (`event.source`), and this module accepts only the two shapes our script sends, a finite height
 * and a safe address - anything else is dropped and logged by the caller.
 */

/** The tallest the frame is drawn; a taller document scrolls inside it. */
export const MAIL_FRAME_MAX_HEIGHT_PX = 20000;

/** A message the parent acts on. */
export type MailFrameMessage = { kind: 'height'; height: number } | { kind: 'link'; href: string };

/** The message `data` carries, or `null` when it is not one our script sends. */
export function readMailFrameMessage(data: unknown): MailFrameMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as { type?: unknown; h?: unknown; href?: unknown };
  if (message.type === 'mail-frame-height') {
    const h = message.h;
    if (typeof h !== 'number' || !Number.isFinite(h) || h < 0) return null;
    return { kind: 'height', height: Math.ceil(h) };
  }
  if (message.type === 'mail-frame-link') {
    const href = message.href;
    if (typeof href !== 'string' || !isSafeMailLink(href)) return null;
    return { kind: 'link', href: href.trim() };
  }
  return null;
}

/**
 * The height to draw the frame at for a reported document `height`, and whether the cap cut it.
 * The cap is what makes the sizing TERMINATE whatever the mail's CSS does: a document that grows
 * with its frame (a percentage height past 100 %) climbs to the cap and stops there.
 */
export function cappedFrameHeight(height: number): { height: number; capped: boolean } {
  if (height > MAIL_FRAME_MAX_HEIGHT_PX) return { height: MAIL_FRAME_MAX_HEIGHT_PX, capped: true };
  return { height, capped: false };
}
