/** Full composer state saved while creating a post (images are not persisted). */
export interface PostComposerDraft {
  version: 1;
  markdown: string;
  imageCaptions: string[];
  includePoll: boolean;
  pollQuestion: string;
  pollOptionsRaw: string;
  pollMultipleChoice: boolean;
  includeEventButton: boolean;
  eventLabel: string;
  eventId: string;
  eventRequiresPayment: boolean;
  eventAmount: number;
  eventCurrency: string;
  eventCapacity: number;
  eventFormId: string;
  includeForm: boolean;
  selectedFormId: string;
  scheduledAt: string;
  selectedAssociationId: string;
  selectedPaymentAssociationId: string;
  selectedLinkedCalendarEventId: string;
}

export const POST_COMPOSER_DRAFT_KEY = 'canari_post_composer_draft';
/** @deprecated Legacy markdown-only key; migrated on read. */
const LEGACY_MARKDOWN_DRAFT_KEY = 'canari_post_draft';

export const POST_NEW_FORM_ID_KEY = 'canari_post_new_form_id';
export const POST_NEW_FORM_ATTACH_KEY = 'canari_post_new_form_attach';

export function buildCreateFormHref(attach: 'form' | 'event', returnTo = '/posts'): string {
  const params = new URLSearchParams({ returnTo, attach });
  return `/forms/create?${params.toString()}`;
}

export function savePostComposerDraft(draft: PostComposerDraft): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(POST_COMPOSER_DRAFT_KEY, JSON.stringify(draft));
  localStorage.removeItem(LEGACY_MARKDOWN_DRAFT_KEY);
}

export function loadPostComposerDraft(): PostComposerDraft | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(POST_COMPOSER_DRAFT_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PostComposerDraft;
      if (parsed?.version === 1) return parsed;
    } catch {
      /* fall through */
    }
  }
  const legacyMarkdown = localStorage.getItem(LEGACY_MARKDOWN_DRAFT_KEY);
  if (legacyMarkdown?.trim()) {
    return emptyPostComposerDraft(legacyMarkdown);
  }
  return null;
}

export function clearPostComposerDraft(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(POST_COMPOSER_DRAFT_KEY);
  localStorage.removeItem(LEGACY_MARKDOWN_DRAFT_KEY);
}

export function emptyPostComposerDraft(markdown = ''): PostComposerDraft {
  return {
    version: 1,
    markdown,
    imageCaptions: [],
    includePoll: false,
    pollQuestion: '',
    pollOptionsRaw: 'Oui\nNon',
    pollMultipleChoice: false,
    includeEventButton: false,
    eventLabel: "S'inscrire",
    eventId: '',
    eventRequiresPayment: false,
    eventAmount: 25,
    eventCurrency: 'eur',
    eventCapacity: 100,
    eventFormId: '',
    includeForm: false,
    selectedFormId: '',
    scheduledAt: '',
    selectedAssociationId: '',
    selectedPaymentAssociationId: '',
    selectedLinkedCalendarEventId: '',
  };
}

/** ISO string if form is not open yet; null if open or no schedule. */
export function formOpensAtIso(opensAt?: string | null): string | null {
  if (!opensAt) return null;
  const t = new Date(opensAt).getTime();
  if (Number.isNaN(t) || t <= Date.now()) return null;
  return new Date(opensAt).toISOString();
}

export function formatFormOpensAt(opensAt: string): string {
  return new Date(opensAt).toLocaleString('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
