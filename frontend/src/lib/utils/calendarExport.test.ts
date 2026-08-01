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
  it('merges two logos into one circle split into halves (not a row of small logos)', () => {
    const html = splitLogoWatermark(['/logo1.png', '/logo2.png'], 40);
    // A single circular clip container...
    expect(html).toContain('border-radius:50%');
    // ...holding one window per logo (a band), each shifted so only its own vertical slice shows.
    const bandCount = (html.match(/<img /g) ?? []).length;
    expect(bandCount).toBe(2);
    expect(html).toContain('left:0.00px'); // first band anchored at the left edge
    expect(html).toContain('left:20.00px'); // second band starts at the half (size / 2)
    // The image inside the second band is shifted left by the band width so the halves align.
    expect(html).toContain('left:-20.00px');
    // It must NOT fall back to the old side-by-side small-logo row.
    expect(html).not.toContain('gap:3px');
  });

  it('leaves an owner half empty rather than renumbering the bands', () => {
    // A band belongs to an OWNER, so an unresolved logo must not shift the next one into its place.
    // Compacting the array instead is what disguised a missing logo as a correct render: two owners
    // with one usable logo fell to the single-logo branch and drew it whole across the circle.
    const html = splitLogoWatermark(['/logo1.png', null], 40);

    expect((html.match(/<img /g) ?? []).length).toBe(1);
    // The surviving logo keeps the LEFT band - it does not slide over or grow to fill the circle.
    expect(html).toContain('left:0.00px');
    expect(html).not.toContain('left:20.00px');
  });

  it('keeps the second owner on the right when only the first logo is missing', () => {
    const html = splitLogoWatermark([null, '/logo2.png'], 40);

    expect((html.match(/<img /g) ?? []).length).toBe(1);
    expect(html).toContain('left:20.00px'); // still the RIGHT band
    expect(html).toContain('left:-20.00px'); // still showing its own right half
  });
});
