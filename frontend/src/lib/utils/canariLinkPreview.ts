import { getAssociation, getAssociationBySlug, associationLogoSrc } from '$lib/associations/api';
import {
  FormNotFoundError,
  getForm,
  getPublicForm,
  PublicFormUnavailableError,
  type Form,
  type PublicForm,
} from '$lib/forms/api';
import { formatAmount } from '$lib/forms/fillAnswers';
import { formatFormOpensAt } from '$lib/posts/postComposerDraft';
import { refusalStatus } from '$lib/utils/apiRefusal';
import { avatarUrl } from '$lib/utils/avatarUrl';
import { Log } from '$lib/utils/Log';
import { getPost, isReel } from '$lib/posts/api';
import { getGroupInvitePreview } from '$lib/mls/groupInvites';
import { channelService } from '$lib/services/ChannelService';
import { markdownToPlainText, truncateForMeta } from '$lib/seo/text';
import { m } from '$lib/paraglide/messages';
import {
  CANARI_BADGE_LABEL,
  parseCanariLinkTarget,
  postAuthorDisplayName,
  postPreviewTitle,
  type CanariLinkPreview,
} from '$lib/utils/canariLinkPreviewFormat';
import { publicAppLinkLabel } from '$lib/utils/publicAppUrl';
import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';

export type { CanariLinkPreview, CanariLinkTarget } from '$lib/utils/canariLinkPreviewFormat';
export {
  parseCanariLinkTarget,
  postAuthorDisplayName,
  postPreviewTitle,
} from '$lib/utils/canariLinkPreviewFormat';

const previewCache = new Map<string, CanariLinkPreview>();
const PREVIEW_CACHE_MAX = 80;

function cachePreview(href: string, preview: CanariLinkPreview): CanariLinkPreview {
  if (previewCache.size >= PREVIEW_CACHE_MAX) {
    const first = previewCache.keys().next().value;
    if (first) previewCache.delete(first);
  }
  previewCache.set(href, preview);
  return preview;
}

/** Returns a cached preview for `href` when already loaded. */
export function getCachedCanariLinkPreview(href: string): CanariLinkPreview | null {
  return previewCache.get(href) ?? null;
}

async function fetchPostPreview(postId: string): Promise<CanariLinkPreview> {
  const post = await getPost(postId);
  return {
    kind: 'post',
    categoryLabel: m.link_label_post(),
    title: postPreviewTitle(post),
    subtitle: postAuthorDisplayName(post),
    // The small thumbnail stays the association logo (or brand mark for a personal post) -
    // the post's own photo, when it has one, is a separate full-width banner (see `postImage`),
    // never a stand-in for the logo slot.
    imageUrl: post.association?.logoUrl ? associationLogoSrc(post.association.logoUrl) : null,
    postImage: post.media?.find((item) => item.type === 'image') ?? null,
    reelPost: isReel(post) ? post : null,
  };
}

/**
 * The one line saying whether a form takes answers now: closed by a manager, not open yet, full, or
 * open. `now` is a parameter so a test never asserts a wall clock.
 */
export function formStateLabel(
  form: Pick<Form, 'closedAt' | 'opensAt'> & { formFull?: boolean },
  now: number = Date.now()
): string {
  if (form.closedAt) return m.link_preview_form_closed();
  if (form.opensAt && new Date(form.opensAt).getTime() > now) {
    return m.link_preview_form_opens_on({ date: formatFormOpensAt(form.opensAt) });
  }
  if (form.formFull) return m.link_preview_form_full();
  return m.link_preview_form_open();
}

/**
 * Whether `err` is the server ANSWERING that this viewer cannot read the target (a 4xx, or the
 * typed not-found of the form readers), as opposed to nobody answering. An answer is final and
 * cached; a transport failure is retried by the next card.
 */
export function isUnreadableAnswer(err: unknown): boolean {
  if (err instanceof FormNotFoundError) return true;
  if (err instanceof PublicFormUnavailableError) return err.notFound;
  const status = refusalStatus(err);
  return status !== null && status >= 400 && status < 500;
}

/**
 * A form's card: its title, its banner (else the association's logo), and the association's name
 * with the form's state. Read with the viewer's session first; a form that session cannot read
 * (a guest link opened while signed in as a non-member, a 403/404) falls to the guest read, whose
 * answer is the same form as the page `/f/<id>` itself shows.
 */
async function fetchFormPreview(formId: string): Promise<CanariLinkPreview> {
  let form: Form | PublicForm;
  try {
    form = await getForm(formId);
  } catch (err) {
    if (!isUnreadableAnswer(err)) throw err;
    Log.d('LINK_PREVIEW', `form ${formId}: member read refused, trying the guest read`);
    form = await getPublicForm(formId);
  }
  const associationId = 'associationId' in form ? form.associationId : undefined;
  const associationName = 'associationName' in form ? form.associationName : null;
  const state = formStateLabel(form);

  let imageUrl = associationLogoSrc(form.imageUrl);
  if (!imageUrl && associationId) {
    try {
      imageUrl = associationLogoSrc((await getAssociation(associationId)).logoUrl);
    } catch (err) {
      // The logo is garnish: the card is complete without it.
      Log.d('LINK_PREVIEW', `form ${formId}: association logo not read: ${String(err)}`);
    }
  }

  const description = form.description?.trim()
    ? truncateForMeta(markdownToPlainText(form.description), 90)
    : undefined;
  const price = form.basePrice > 0 ? formatAmount(form.basePrice, form.currency) : undefined;
  const stateLine = associationName
    ? m.link_preview_form_by({ state, association: associationName })
    : state;

  return {
    kind: 'form',
    categoryLabel: m.link_label_form(),
    title: form.title?.trim() || m.link_label_form(),
    subtitle: [stateLine, description ?? price].filter(Boolean).join(' - '),
    imageUrl,
  };
}

async function fetchAssociationPreview(slug: string): Promise<CanariLinkPreview> {
  const asso = await getAssociationBySlug(slug);
  const subtitle = asso.description?.trim()
    ? truncateForMeta(asso.description, 90)
    : asso.memberCount != null
      ? `${asso.memberCount} membre${asso.memberCount > 1 ? 's' : ''}`
      : undefined;

  return {
    kind: 'association',
    categoryLabel: m.link_label_association(),
    title: asso.name,
    subtitle,
    imageUrl: associationLogoSrc(asso.logoUrl),
  };
}

async function fetchProfilePreview(userId: string): Promise<CanariLinkPreview> {
  const resolved = await resolveUserDisplayName(userId).catch((err: unknown) => {
    Log.d('LINK_PREVIEW', `profile ${userId}: name not resolved: ${String(err)}`);
    return null;
  });
  return {
    kind: 'profile',
    categoryLabel: m.link_label_profile(),
    title: resolved || getUserDisplayNameSync(userId, userId),
    subtitle: m.link_preview_profile_member(),
    imageUrl: avatarUrl(userId),
  };
}

async function fetchCommunityInvitePreview(token: string): Promise<CanariLinkPreview> {
  const preview = await channelService.getInvitePreview(token);
  return {
    kind: 'route',
    categoryLabel: m.link_label_community_invite(),
    title: preview.workspaceName?.trim() || m.link_label_community(),
    subtitle: preview.valid ? m.link_preview_join_community() : m.link_preview_invite_invalid(),
    imageUrl: preview.imageMediaId ? `/api/media/public/${preview.imageMediaId}` : null,
  };
}

async function fetchGroupInvitePreview(token: string): Promise<CanariLinkPreview> {
  const preview = await getGroupInvitePreview(token);
  return {
    kind: 'route',
    categoryLabel: m.link_label_group_invite(),
    title: preview.groupName?.trim() || m.link_label_chat(),
    subtitle: preview.valid ? m.link_preview_join_conversation() : m.link_preview_invite_invalid(),
  };
}

/**
 * Loads title, subtitle, and optional image for a Canari in-app URL.
 * Results are cached per href string.
 */
export async function fetchCanariLinkPreview(href: string): Promise<CanariLinkPreview | null> {
  const cached = previewCache.get(href);
  if (cached) return cached;

  const target = parseCanariLinkTarget(href);
  if (!target) return null;

  try {
    let preview: CanariLinkPreview;
    switch (target.kind) {
      case 'post':
        preview = await fetchPostPreview(target.postId);
        break;
      case 'form':
      case 'guest-form':
        preview = await fetchFormPreview(target.formId);
        break;
      case 'association':
        preview = await fetchAssociationPreview(target.slug);
        break;
      case 'profile':
        preview = await fetchProfilePreview(target.userId);
        break;
      case 'community-invite':
        preview = await fetchCommunityInvitePreview(target.token);
        break;
      case 'group-invite':
        preview = await fetchGroupInvitePreview(target.token);
        break;
      case 'route':
        // A plain route has no entity behind it, so the badge falls back to the brand -
        // the in-app equivalent of the host chip an external card shows - and the label
        // is the title. Both carried the label before, printing it twice per card.
        preview = {
          kind: 'route',
          categoryLabel: CANARI_BADGE_LABEL,
          title: target.label,
          subtitle: m.link_preview_open_in_canari(),
        };
        break;
    }
    return cachePreview(href, preview);
  } catch (err) {
    // A 403/404 is the server's ANSWER (restricted, deleted): the generic card is correct and kept.
    // A transport failure is not an answer: the same generic card, but not remembered, so the next
    // card for this link asks again.
    const answered = isUnreadableAnswer(err);
    Log.d(
      'LINK_PREVIEW',
      `${target.kind} ${href}: ${answered ? 'unreadable by this viewer' : 'not reached'}: ${String(err)}`
    );
    const fallback: CanariLinkPreview = {
      kind: 'route',
      categoryLabel: CANARI_BADGE_LABEL,
      title: publicAppLinkLabel(href) ?? m.link_label_generic(),
      subtitle: m.link_preview_unavailable(),
    };
    return answered ? cachePreview(href, fallback) : fallback;
  }
}
