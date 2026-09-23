import { emptyPollOptions, newPollOption, type PollDraftOption } from './pollDraft';

/**
 * Sentinel value of `selectedAssociationId`/`PostComposerDraft.selectedAssociationId` meaning "post
 * anonymously" - one more entry in the same "which identity publishes this" choice as a real
 * association's UUID, never a value a real association id can equal.
 */
export const ANONYMOUS_POST_IDENTITY = '__anonymous__';

/** Full composer state saved while creating a post (images are not persisted). */
export interface PostComposerDraft {
  version: 1;
  markdown: string;
  imageCaptions: string[];
  includePoll: boolean;
  pollQuestion: string;
  /**
   * One entry per option row, blanks included.
   *
   * This was `pollOptionsRaw`, a single newline-separated string, until 2026-09-23 - see
   * `pollDraft.ts` for what that cost a reader. A draft written before that day is migrated on
   * read rather than discarded, which is why there is no `version: 2`: the shape is still one
   * object of scalars and arrays, and a reader mid-post must not lose it to a deploy.
   */
  pollOptions: PollDraftOption[];
  pollMultipleChoice: boolean;
  /** How many options one voter may pick, or `null` for no limit. */
  pollMaxSelections: number | null;
  /** `datetime-local` value at which the poll closes, or `''`. */
  pollEndsAt: string;
  includeForm: boolean;
  selectedFormId: string;
  scheduledAt: string;
  selectedAssociationId: string;
  selectedLinkedCalendarEventId: string;
}

export const POST_COMPOSER_DRAFT_KEY = 'canari_post_composer_draft';
/** @deprecated Legacy markdown-only key; migrated on read. */
const LEGACY_MARKDOWN_DRAFT_KEY = 'canari_post_draft';

export const POST_NEW_FORM_ID_KEY = 'canari_post_new_form_id';

/** URL to create a form and return to the post composer with it attached. */
export function buildCreateFormHref(returnTo = '/posts'): string {
  const params = new URLSearchParams({ returnTo, attach: 'form' });
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
      const parsed = JSON.parse(raw) as PostComposerDraft & Record<string, unknown>;
      if (parsed?.version === 1) {
        let selectedAssociationId =
          typeof parsed.selectedAssociationId === 'string' ? parsed.selectedAssociationId : '';
        // A draft saved while the options were one newline-separated string (before 2026-09-23)
        // still restores, split on the separator that was structural at the time. An id is minted
        // for each restored row: the draft is a poll that has never been saved, so no vote can be
        // attached to any of them yet.
        const pollOptions = Array.isArray(parsed.pollOptions)
          ? parsed.pollOptions.map(readDraftOption)
          : typeof parsed.pollOptionsRaw === 'string'
            ? parsed.pollOptionsRaw.split('\n').map((label) => newPollOption(label))
            : emptyPollOptions();
        // A draft saved before "Anonyme" became an identity option (2026-09-17) carried its own
        // boolean instead - fold it into the same field so an old draft still restores correctly.
        if (!selectedAssociationId && parsed.anonymous === true) {
          selectedAssociationId = ANONYMOUS_POST_IDENTITY;
        }
        return {
          version: 1,
          markdown: typeof parsed.markdown === 'string' ? parsed.markdown : '',
          imageCaptions: Array.isArray(parsed.imageCaptions)
            ? parsed.imageCaptions.map(String)
            : [],
          includePoll: !!parsed.includePoll,
          pollQuestion: typeof parsed.pollQuestion === 'string' ? parsed.pollQuestion : '',
          pollOptions,
          pollMultipleChoice: !!parsed.pollMultipleChoice,
          pollMaxSelections:
            typeof parsed.pollMaxSelections === 'number' ? parsed.pollMaxSelections : null,
          pollEndsAt: typeof parsed.pollEndsAt === 'string' ? parsed.pollEndsAt : '',
          includeForm: !!parsed.includeForm,
          selectedFormId: typeof parsed.selectedFormId === 'string' ? parsed.selectedFormId : '',
          scheduledAt: typeof parsed.scheduledAt === 'string' ? parsed.scheduledAt : '',
          selectedAssociationId,
          selectedLinkedCalendarEventId:
            typeof parsed.selectedLinkedCalendarEventId === 'string'
              ? parsed.selectedLinkedCalendarEventId
              : '',
        };
      }
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
    pollOptions: emptyPollOptions(),
    pollMultipleChoice: false,
    pollMaxSelections: null,
    pollEndsAt: '',
    includeForm: false,
    selectedFormId: '',
    scheduledAt: '',
    selectedAssociationId: '',
    selectedLinkedCalendarEventId: '',
  };
}

/** One persisted option row, whatever shape the draft that holds it was written in. */
function readDraftOption(raw: unknown): PollDraftOption {
  if (raw && typeof raw === 'object') {
    const { id, label } = raw as Partial<PollDraftOption>;
    return {
      id: typeof id === 'string' && id ? id : crypto.randomUUID(),
      label: String(label ?? ''),
    };
  }
  return newPollOption(String(raw ?? ''));
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
