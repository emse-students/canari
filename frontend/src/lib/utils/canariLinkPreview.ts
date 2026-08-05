import { getAssociationBySlug, associationLogoSrc } from '$lib/associations/api';
import { getForm } from '$lib/forms/api';
import { getPost } from '$lib/posts/api';
import { getGroupInvitePreview } from '$lib/mls/groupInvites';
import { channelService } from '$lib/services/ChannelService';
import { markdownToPlainText, truncateForMeta } from '$lib/seo/text';
import { m } from '$lib/paraglide/messages';
import {
  CANARI_BADGE_LABEL,
  formatPriceCents,
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
    imageUrl: post.association?.logoUrl ? associationLogoSrc(post.association.logoUrl) : null,
  };
}

async function fetchFormPreview(formId: string): Promise<CanariLinkPreview> {
  const form = await getForm(formId);
  const subtitle = form.description?.trim()
    ? truncateForMeta(markdownToPlainText(form.description), 90)
    : form.basePrice > 0
      ? formatPriceCents(form.basePrice, form.currency)
      : undefined;

  return {
    kind: 'form',
    categoryLabel: m.link_label_form(),
    title: form.title?.trim() || m.link_label_form(),
    subtitle,
    imageUrl: form.imageUrl?.trim() || null,
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
  const title = getUserDisplayNameSync(userId, userId);
  void resolveUserDisplayName(userId);
  return {
    kind: 'profile',
    categoryLabel: m.link_label_profile(),
    title,
    subtitle: m.link_preview_profile_member(),
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
    console.log('[canariLinkPreview] fetch failed:', href, err);
    const fallback: CanariLinkPreview = {
      kind: 'route',
      categoryLabel: CANARI_BADGE_LABEL,
      title: publicAppLinkLabel(href) ?? m.link_label_generic(),
      subtitle: m.link_preview_unavailable(),
    };
    return cachePreview(href, fallback);
  }
}
