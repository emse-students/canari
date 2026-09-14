import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * THE POSTER FOLLOWS THE EVENT, NOT THE PAGE.
 *
 * The global agenda can move an event from one association to another inside the open form, and it
 * is the only surface that can - so the association these endpoints address is read at CALL time
 * from the surface, never captured when the form opened. The rest of what is pinned here is the
 * part the association's page had and the agenda went without entirely: an in-flight flag that
 * clears even when the upload is refused, and a refusal that RETHROWS so the modal's error line is
 * the one that fills.
 */
const uploadCalendarEventImage = vi.fn();
const deleteCalendarEventImage = vi.fn();

vi.mock('$lib/associations/api', () => ({
  uploadCalendarEventImage: (...args: unknown[]) => uploadCalendarEventImage(...args),
  deleteCalendarEventImage: (...args: unknown[]) => deleteCalendarEventImage(...args),
}));

const { createEventPoster } = await import('./eventPoster.svelte');

describe('createEventPoster', () => {
  let association = 'asso-1';
  let event: string | null = 'ev-1';
  let reloads = 0;

  function make() {
    return createEventPoster({
      associationId: () => association,
      eventId: () => event,
      onChanged: async () => {
        reloads += 1;
      },
    });
  }

  beforeEach(() => {
    association = 'asso-1';
    event = 'ev-1';
    reloads = 0;
    uploadCalendarEventImage.mockReset();
    deleteCalendarEventImage.mockReset();
  });

  it('uploads against the association and event the surface holds AT CALL TIME', async () => {
    uploadCalendarEventImage.mockResolvedValue({ imageUrl: '/api/media/public/m1' });
    const poster = make();

    association = 'asso-2';
    event = 'ev-2';
    const file = new File(['x'], 'poster.png');
    await poster.controls.onUpload(file);

    expect(uploadCalendarEventImage).toHaveBeenCalledWith('asso-2', 'ev-2', file);
    expect(poster.controls.url).toBe('/api/media/public/m1');
    expect(reloads).toBe(1);
  });

  it('does nothing at all while creating - the endpoint addresses an existing row', async () => {
    event = null;
    const poster = make();

    await poster.controls.onUpload(new File(['x'], 'poster.png'));
    await poster.controls.onRemove();

    expect(uploadCalendarEventImage).not.toHaveBeenCalled();
    expect(deleteCalendarEventImage).not.toHaveBeenCalled();
    expect(reloads).toBe(0);
  });

  it('clears the poster on removal', async () => {
    deleteCalendarEventImage.mockResolvedValue(undefined);
    const poster = make();
    poster.set('/api/media/public/old');

    await poster.controls.onRemove();

    expect(deleteCalendarEventImage).toHaveBeenCalledWith('asso-1', 'ev-1');
    expect(poster.controls.url).toBeNull();
  });

  it('rethrows a refusal and still puts the control back', async () => {
    uploadCalendarEventImage.mockRejectedValue(new Error('refused'));
    const poster = make();
    poster.set('/api/media/public/kept');

    await expect(poster.controls.onUpload(new File(['x'], 'p.png'))).rejects.toThrow('refused');
    expect(poster.controls.uploading).toBe(false);
    // The picture on the server did not change, so neither does the one on screen.
    expect(poster.controls.url).toBe('/api/media/public/kept');
    expect(reloads).toBe(0);
  });
});
