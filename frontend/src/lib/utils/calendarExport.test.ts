import { eventBgCss, splitLogoWatermark } from './calendarExport';
import type { AssociationCalendarFeedEvent } from '$lib/associations/api';

/** Minimal feed-event factory: only the fields the visual helpers read need to be meaningful. */
function makeEvent(
  overrides: Partial<AssociationCalendarFeedEvent> = {}
): AssociationCalendarFeedEvent {
  return {
    id: 'ev-1',
    associationId: 'assoc-1',
    title: 'Soiree',
    description: null,
    startsAt: '2026-05-13T12:00:00.000Z',
    endsAt: null,
    createdBy: 'u-1',
    createdAt: '2026-05-01T00:00:00.000Z',
    kind: 'event',
    status: 'approved' as AssociationCalendarFeedEvent['status'],
    validatedAt: null,
    validatedBy: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectionReason: null,
    linkedFormId: null,
    imageUrl: null,
    coOwners: [],
    associationName: 'Asso 1',
    associationSlug: 'asso-1',
    associationColor: '#ff0000',
    associationLogoUrl: '/logo1.png',
    ...overrides,
  };
}

describe('eventBgCss', () => {
  it('renders a single owner as a translucent solid fill (softened, not full opacity)', () => {
    const css = eventBgCss(makeEvent());
    expect(css).toBe('rgba(255,0,0,0.82)');
  });

  it('renders a co-owned event as a gradient of equal translucent bands', () => {
    const css = eventBgCss(
      makeEvent({
        associationColor: '#ff0000',
        coOwners: [
          {
            associationId: 'assoc-2',
            name: 'Asso 2',
            slug: 'asso-2',
            color: '#0000ff',
            logoUrl: '/logo2.png',
          },
        ],
      })
    );
    expect(css).toContain('linear-gradient(to right,');
    // Both owners contribute a translucent stop; neither is fully opaque.
    expect(css).toContain('rgba(255,0,0,0.82) 0.0%');
    expect(css).toContain('rgba(0,0,255,0.82) 50.0%');
    expect(css).not.toContain('#ff0000');
  });
});

describe('splitLogoWatermark', () => {
  it('draws every owner logo whole, side by side', () => {
    const html = splitLogoWatermark(['/logo1.png', '/logo2.png'], 40);

    expect((html.match(/<img /g) ?? []).length).toBe(2);
    // Each logo keeps the full diameter a single-owner event uses - no slicing, no shrinking.
    expect((html.match(/width:40px;height:40px/g) ?? []).length).toBe(2);
    expect(html).toContain('gap:3px');
    // The watermark used to merge the two into one circle, each contributing a vertical half. It
    // composed as designed and still failed: half a seal reads as a cropped image, not as a logo.
    expect(html).not.toContain('left:-20.00px');
  });

  it('keeps the logos centred over the split background, so each sits on its own half', () => {
    const html = splitLogoWatermark(['/a.png', '/b.png'], 30);
    expect(html).toContain('justify-content:center');
    expect(html).toContain('align-items:center');
    // Decorative only: it must never intercept a click or shift the cell's flow.
    expect(html).toContain('position:absolute;inset:0');
    expect(html).toContain('pointer-events:none');
  });
});
