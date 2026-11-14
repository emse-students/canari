import { m } from '$lib/paraglide/messages';

/**
 * Why media-service ANSWERED without the durations it holds (core's `MediaRefusalReason`): a status
 * code is an answer, kept apart from a transport failure.
 */
export type RetentionRefusalReason = 'secret' | 'route' | 'malformed' | 'status';

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

/** Whether core's answer has a state this page knows; anything else is a failed read. */
export function isRetentionAppliedAnswer(body: unknown): body is RetentionAppliedAnswer {
  return (
    typeof body === 'object' &&
    body !== null &&
    STATES.has(String((body as { state?: unknown }).state))
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
      const status = view.refusal?.status ?? 0;
      switch (view.refusal?.reason) {
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
