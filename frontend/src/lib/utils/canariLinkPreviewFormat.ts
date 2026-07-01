import type { PostEntity } from '$lib/posts/api';
import { markdownToPlainText, truncateForMeta } from '$lib/seo/text';
import { inAppPathFromHref, publicAppLinkLabel } from '$lib/utils/publicAppUrl';

/** Resolved metadata for an in-app Canari link (chat / post preview cards). */
export interface CanariLinkPreview {
  kind: 'post' | 'form' | 'association' | 'profile' | 'route';
  categoryLabel: string;
  title: string;
  subtitle?: string;
  /** Public image URL (form banner, association logo). */
  imageUrl?: string | null;
}

export type CanariLinkTarget =
  | { kind: 'post'; postId: string }
  | { kind: 'form'; formId: string }
  | { kind: 'association'; slug: string }
  | { kind: 'profile'; userId: string }
  | { kind: 'community-invite'; token: string }
  | { kind: 'group-invite'; token: string }
  | { kind: 'route'; categoryLabel: string };

/**
 * Parses an in-app href into a fetch target, or null when the route is not supported.
 */
export function parseCanariLinkTarget(href: string): CanariLinkTarget | null {
  const path = inAppPathFromHref(href);
  if (!path) return null;

  const pathname = path.split(/[?#]/)[0] || '/';
  const post = pathname.match(/^\/posts\/([^/]+)$/);
  if (post) return { kind: 'post', postId: post[1] };

  const form = pathname.match(/^\/forms\/([^/]+)$/);
  if (form) return { kind: 'form', formId: form[1] };

  const asso = pathname.match(/^\/associations\/([^/]+)$/);
  if (asso) return { kind: 'association', slug: asso[1] };

  const profile = pathname.match(/^\/profile\/([^/]+)$/);
  if (profile) return { kind: 'profile', userId: profile[1] };

  const communityInvite = pathname.match(/^\/c\/join\/([^/]+)$/);
  if (communityInvite) return { kind: 'community-invite', token: communityInvite[1] };

  const groupInvite = pathname.match(/^\/g\/join\/([^/]+)$/);
  if (groupInvite) return { kind: 'group-invite', token: groupInvite[1] };

  const label = publicAppLinkLabel(href);
  if (label) return { kind: 'route', categoryLabel: label };

  return null;
}

/** Display name for a post author (association or user). */
export function postAuthorDisplayName(post: PostEntity): string {
  if (post.association?.name) return post.association.name;
  const first = post.authorFirstName?.trim();
  const last = post.authorLastName?.trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;
  if (post.authorDisplayName?.trim()) return post.authorDisplayName.trim();
  return post.authorId ?? 'Auteur';
}

/** Short title line from post markdown. */
export function postPreviewTitle(post: PostEntity): string {
  const plain = markdownToPlainText(post.markdown);
  if (!plain) return 'Publication sans texte';
  return truncateForMeta(plain, 100);
}

/** Formats a Stripe-style amount stored in cents. */
export function formatPriceCents(cents: number, currency = 'eur'): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: (currency || 'eur').toUpperCase(),
  }).format(cents / 100);
}
