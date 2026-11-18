import { m } from '$lib/paraglide/messages';

/**
 * Why media-service ANSWERED without the durations it holds (core's `MediaRefusalReason`): a status
 * code is an answer, kept apart from a transport failure.
 */
type RetentionRefusalReason = 'secret' | 'route' | 'malformed' | 'status';

/** Core's answer to `GET /api/users/admin/platform/retention-applied` (the fields the page reads). */
export interface RetentionAppliedAnswer {
  state: 'applied' | 'behind' | 'refused' | 'unreachable';
  refusal: { status: number; reason: RetentionRefusalReason } | null;
}

/**
 * What the admin page shows: core's answer, or `failed` when THIS page's own request to core did not
 * succeed - which says nothing about media-service.
 */
export type RetentionAppliedView = RetentionAppliedAnswer | { state: 'failed'; refusal: null };

const STATES: ReadonlySet<string> = new Set(['applied', 'behind', 'refused', 'unreachable']);
const REASONS: ReadonlySet<string> = new Set(['secret', 'route', 'malformed', 'status']);

/**
 * Whether core's answer is one this page can word: a known state, and - for `refused` - a refusal
 * with its status and a known reason (never worded "HTTP 0"). Anything else is a failed read.
 */
export function isRetentionAppliedAnswer(body: unknown): body is RetentionAppliedAnswer {
  if (typeof body !== 'object' || body === null) return false;
  const { state, refusal } = body as { state?: unknown; refusal?: unknown };
  if (!STATES.has(String(state))) return false;
  if (state !== 'refused') return true;
  if (typeof refusal !== 'object' || refusal === null) return false;
  const { status, reason } = refusal as { status?: unknown; reason?: unknown };
  return (
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status > 0 &&
    REASONS.has(String(reason))
  );
}

/** The sentence for a state that is not `applied`, each cause worded apart. */
export function retentionAppliedText(view: RetentionAppliedView): string {
  switch (view.state) {
    case 'applied':
      return '';
    case 'behind':
      return m.admin_platform_retention_not_applied();
    case 'unreachable':
      return m.admin_platform_retention_media_unreachable();
    case 'failed':
      return m.admin_platform_retention_read_failed();
    case 'refused': {
      // `isRetentionAppliedAnswer` let no `refused` through without its refusal.
      const { status, reason } = view.refusal!;
      switch (reason) {
        case 'secret':
          return m.admin_platform_retention_media_refused_secret({ status });
        case 'route':
          return m.admin_platform_retention_media_refused_route({ status });
        case 'malformed':
          return m.admin_platform_retention_media_refused_malformed();
        default:
          return m.admin_platform_retention_media_refused_status({ status });
      }
    }
  }
}
