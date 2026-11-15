import type { PostEntity, PostMediaRef } from '$lib/posts/api';
import { markdownToPlainText } from '$lib/seo/text';
import { extractPreviewUrls } from '$lib/utils/chat/messageDisplay';
import { codeBlockLines } from '$lib/utils/markdownCode';
import { parseCanariLinkTarget } from '$lib/utils/canariLinkPreviewFormat';
import { resolveMediaType } from '$lib/utils/mediaLayout';

/**
 * One card of a post's card zone - the ONE family every non-media attachment is drawn in
 * (`AttachmentCard`, owner 2026-11-15: "Une seule famille de cartes").
 */
export type PostCardItem =
  | { kind: 'event' }
  | { kind: 'form'; formId: string }
  | { kind: 'file'; media: PostMediaRef }
  | { kind: 'link'; url: string };

/** What a post draws below its header, in the order it draws it. */
export interface PostAttachmentPlan {
  /** The text as drawn: every URL that has a card AND ends its line is taken out of it. */
  markdown: string;
  /** Pictures and videos, the gallery's cells (full-bleed, between the text and the cards). */
  media: PostMediaRef[];
  /** The card zone, in its fixed order: event, attached forms, files, then the text's links. */
  cards: PostCardItem[];
  /** The lone card is drawn LARGE (`HERO_TEXT_MAX`, {@link planPostAttachments}). */
  hero: boolean;
}

/**
 * How much text a post may carry and still put its lone attachment forward: a caption, not an
 * article. Counted on the PLAIN text (Markdown marks and the URL the card replaces left out), so
 * "Inscriptions ici" above a form link qualifies and three paragraphs do not. 140 is the length of
 * a one-sentence caption, two lines on a phone card - what Instagram shows under a picture before
 * "plus". Counted in characters as a reader sees them (graphemes), never in UTF-16 units.
 */
export const HERO_TEXT_MAX = 140;

/** The post fields the plan reads. */
export type PlannedPost = Pick<PostEntity, 'markdown'> &
  Partial<Pick<PostEntity, 'media' | 'images' | 'linkedCalendarEvent' | 'polls'>>;

/** Pictures and videos are cells; everything else (files, audio) is a card. */
function isGalleryMedia(media: PostMediaRef): boolean {
  const type = resolveMediaType(media);
  return type === 'image' || type === 'video';
}

/** The form a link names, when it is an in-app form address (`/forms/<id>` or `/f/<id>`). */
function linkedFormId(url: string): string | null {
  const target = parseCanariLinkTarget(url);
  return target?.kind === 'form' || target?.kind === 'guest-form' ? target.formId : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A line's block marker - quote, list bullet or number, heading - kept apart from its words so a
 * stripped URL never leaves a bare `-`, `>`, `1.` or `##` on screen.
 */
const MARKER_RE = /^(\s*(?:>\s?)*\s*(?:[-*+]\s+|\d{1,9}[.)]\s+|#{1,6}\s+)?)(.*)$/;

/** What is left of a line once its URLs went: nothing but sentence punctuation is nothing. */
const ONLY_PUNCTUATION_RE = /^[\s,.!?;:]*$/;

/**
 * The text with the URLs in `carded` removed where they END THEIR LINE - alone on it, after the words
 * that introduce them ("inscription ici https://..."), or as a trailing run ("https://a https://b").
 * A URL in the middle of a sentence stays: taking it out would leave "plus d'infos sur et
 * inscription", and the card under the text says where it goes anyway. Only a BARE URL is taken - a
 * labelled link or an `<url>` autolink is the author's own wording - and nothing in code (a code
 * span cannot match, a fenced or indented block is skipped whole, `codeBlockLines`).
 *
 * The punctuation after the LAST URL of the run stays ("Voir https://x." -> "Voir."); a line left
 * with nothing but its block marker or punctuation goes, marker included. `\r\n` lines are read like
 * `\n` ones and written back as `\n`.
 */
export function stripCardedUrls(markdown: string, carded: readonly string[]): string {
  if (carded.length === 0) return markdown;
  const patterns = carded.map(
    (url) => new RegExp(`(?:^|[ \\t]+)${escapeRegExp(url)}([,.!?;:]*)[ \\t]*$`)
  );
  const lines = markdown.split(/\r?\n/);
  const inCode = codeBlockLines(markdown);
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (inCode[i]) {
      out.push(line);
      return;
    }
    const [, marker, words] = line.match(MARKER_RE) ?? ['', '', line];
    let rest = words;
    let tail: string | null = null;
    for (let changed = true; changed;) {
      changed = false;
      for (const re of patterns) {
        const found = rest.match(re);
        if (!found || found.index === undefined) continue;
        tail ??= found[1];
        rest = rest.slice(0, found.index);
        changed = true;
      }
    }
    if (tail === null) {
      out.push(line);
      return;
    }
    if (ONLY_PUNCTUATION_RE.test(rest)) return;
    out.push(`${marker}${rest.replace(/\s+$/, '')}${tail}`);
  });
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Characters as a reader counts them: a flag or a family emoji is one, not four to eleven. */
function perceivedLength(text: string): number {
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text))
    .length;
}

/**
 * THE LAYOUT OF A POST, DECIDED ONCE (owner, 2026-11-15). The order is fixed - text, media, cards,
 * then (outside this plan) the poll and the action bar - and the card zone draws every attachment
 * that is not a picture or a video:
 *
 * - **event** first, then the **attached forms** in the post's order, then the **files**, then the
 *   **links** of the text in the text's order;
 * - **a form is drawn ONCE**: a link to a form that is also attached is not a second card, the
 *   attached form's card stands for both;
 * - **a URL that has a card leaves the text** where it ends its line ({@link stripCardedUrls});
 * - **hero**: a post whose ONLY attachment is one card - no picture, no video, no poll, no replay,
 *   no second card - and whose plain text is at most {@link HERO_TEXT_MAX} characters puts that card
 *   forward, drawn large. A lone picture is already drawn large, so it needs no rule.
 *
 * @param post The post.
 * @param attachedFormIds The forms attached to it, each once, in its order (`attachedFormSources`).
 * @param replay Whether the post is a live replay (its card is the post's media).
 */
export function planPostAttachments(
  post: PlannedPost,
  attachedFormIds: readonly string[],
  replay = false
): PostAttachmentPlan {
  const all = post.media ?? post.images ?? [];
  const media = all.filter(isGalleryMedia);
  const files = all.filter((item) => !isGalleryMedia(item));

  const source = post.markdown ?? '';
  const links = source ? extractPreviewUrls(source) : [];
  const attached = new Set(attachedFormIds);
  const linkCards = links.filter((url) => {
    const formId = linkedFormId(url);
    return !(formId && attached.has(formId));
  });

  const cards: PostCardItem[] = [
    ...(post.linkedCalendarEvent ? [{ kind: 'event' } as const] : []),
    ...attachedFormIds.map((formId) => ({ kind: 'form', formId }) as const),
    ...files.map((item) => ({ kind: 'file', media: item }) as const),
    ...linkCards.map((url) => ({ kind: 'link', url }) as const),
  ];

  // Every link has a card: its own, or the attached form's it repeats.
  const markdown = stripCardedUrls(source, links);
  const hero =
    cards.length === 1 &&
    media.length === 0 &&
    !replay &&
    !post.polls?.length &&
    perceivedLength(markdownToPlainText(markdown)) <= HERO_TEXT_MAX;

  return { markdown, media, cards, hero };
}
