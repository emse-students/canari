import {
  uploadCalendarEventImage,
  deleteCalendarEventImage,
  type AssociationCalendarEvent,
} from '$lib/associations/api';

/**
 * THE POSTER OF AN EVENT, FOR EVERY SURFACE THAT DRAWS THE EVENT FORM.
 *
 * The upload and the removal address an EXISTING row (`:associationId/events/:eventId/image`), so
 * the three things a surface must supply are the owning association, the event being edited, and
 * what to do once the picture changed. Everything else - the current URL, the in-flight flag, and
 * the rule that both endpoints RETHROW so the modal's own error line is the one that fills - is the
 * same everywhere and lives here.
 *
 * It was written once on the association's page and the global agenda simply did without: from
 * `/calendar` an administrator could edit every field of an event except its poster, for no reason
 * the API knew about. A control that exists on one surface and not another is a second
 * implementation waiting to happen, so there is one.
 */
export interface EventPosterContext {
  /** The association that OWNS the event - never the page's, on a surface that lists several. */
  associationId: () => string;
  /** The event being edited, or null while creating (the poster is offered only on an edit). */
  eventId: () => string | null;
  /** Called after a successful change - the cards carry the poster too, so surfaces reload. */
  onChanged: () => Promise<void>;
}

export interface EventPosterControls {
  url: string | null;
  uploading: boolean;
  onUpload: (file: File) => Promise<void>;
  onRemove: () => Promise<void>;
}

export interface EventPosterState {
  /** Pass straight to `EventFormModal`'s `poster` prop. */
  readonly controls: EventPosterControls;
  /** Seed when opening the form: the edited event's `imageUrl`, or null when creating. */
  set(url: string | null): void;
}

/** Poster state and its two endpoints, bound to one surface's notion of "which event". */
export function createEventPoster(ctx: EventPosterContext): EventPosterState {
  let url = $state<string | null>(null);
  let uploading = $state(false);

  /** Both handlers RETHROW: the modal owns the error line, and a swallowed refusal leaves it empty
   *  while the poster silently stays as it was. */
  async function run(action: () => Promise<AssociationCalendarEvent | void>): Promise<void> {
    const eventId = ctx.eventId();
    if (!eventId) return;
    uploading = true;
    try {
      const updated = await action();
      url = updated?.imageUrl ?? null;
      await ctx.onChanged();
    } finally {
      uploading = false;
    }
  }

  return {
    controls: {
      get url() {
        return url;
      },
      get uploading() {
        return uploading;
      },
      onUpload: (file: File) =>
        run(() => uploadCalendarEventImage(ctx.associationId(), ctx.eventId() as string, file)),
      onRemove: () =>
        run(async () => {
          await deleteCalendarEventImage(ctx.associationId(), ctx.eventId() as string);
        }),
    },
    set(next: string | null) {
      url = next;
    },
  };
}
