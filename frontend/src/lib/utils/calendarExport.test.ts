import {
  DAY_NUM_H,
  EVENT_TITLE_LINE_HEIGHT,
  eventBgCss,
  fitEventText,
  splitLogoBands,
  splitLogoWatermark,
} from './calendarExport';
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

  it('immunises each band image against the app-wide img max-width', () => {
    // This markup renders INSIDE the app document, so Tailwind Preflight's `img { max-width:100% }`
    // applies: without max-width:none the logo is clamped to its BAND instead of the circle, and
    // every band at a negative offset lands entirely outside its own window and paints nothing.
    // The left half survives as a squeezed centre strip, so it reads as "the second logo is
    // missing" - and it is invisible to any probe rendered outside the app, which has no Preflight.
    const html = splitLogoWatermark(['/logo1.png', '/logo2.png'], 40);
    const imgStyles = [...html.matchAll(/<img [^>]*style="([^"]*)"/g)].map((m) => m[1]);

    expect(imgStyles).toHaveLength(2);
    for (const style of imgStyles) {
      expect(style).toContain('max-width:none');
      expect(style).toContain('max-height:none');
      // The image must span the whole circle, never just its own band.
      expect(style).toContain('width:40px');
    }
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

describe('splitLogoBands', () => {
  // This geometry is shared with MonthCalendarGridRich.svelte, which draws the same split on screen.
  // The two surfaces drifted once - the export was fixed while the grid kept a row of small separate
  // logos - so the split is defined here, in percentages, and both read it.
  it('splits the circle into equal bands, each exposing its own slice', () => {
    expect(splitLogoBands(2)).toEqual([
      { leftPct: 0, widthPct: 50, imgLeftPct: -0, imgWidthPct: 200 },
      { leftPct: 50, widthPct: 50, imgLeftPct: -100, imgWidthPct: 200 },
    ]);
  });

  it('scales to any owner count without leaving a gap', () => {
    const bands = splitLogoBands(3);
    expect(bands).toHaveLength(3);
    // Bands tile the circle edge to edge.
    expect(bands.at(-1)!.leftPct + bands.at(-1)!.widthPct).toBeCloseTo(100);
    // Each logo stays circle-wide inside its band, shifted by whole band widths.
    for (const [i, b] of bands.entries()) {
      expect(b.imgWidthPct).toBe(300);
      expect(b.imgLeftPct).toBe(-i * 100);
    }
  });

  it('degenerates to a single full-width band for one owner', () => {
    expect(splitLogoBands(1)).toEqual([
      { leftPct: 0, widthPct: 100, imgLeftPct: -0, imgWidthPct: 100 },
    ]);
  });
});

/** The clamp the fitter chose, read back out of the CSS it returns. */
function clampLines(clampCss: string): number {
  return Number(clampCss.split('-webkit-line-clamp:')[1].split(';')[0]);
}

describe('fitEventText', () => {
  it('keeps the sheet on its own 9px floor', () => {
    // The PDF is rasterised at A4 and read on paper, so it may go where the screen may not. This
    // asserts the DEFAULT, which is what the export calls: adding the screen's parameter must not
    // have moved the sheet a pixel.
    expect(fitEventText(20).fontSize).toBe(9);
    expect(fitEventText(120).fontSize).toBe(13);
  });

  it('never puts the screen below --text-2xs', () => {
    // app.css: 12px "is the single largest contributor to 'pas assez ergonomique'. Nothing goes
    // below this." A fitter free to pick 9 would quietly reintroduce exactly that.
    for (let availH = 4; availH <= 200; availH++) {
      expect(fitEventText(availH, 12).fontSize).toBeGreaterThanOrEqual(12);
    }
  });

  it('buys the screen its fit in lines, which is the day-29 defect', () => {
    // A day with three events in a 128px cell: slots of 42px, and the first spends DAY_NUM_H = 20
    // on the day number, leaving 22. The `line-clamp-2` this replaced asked for two lines - 30px
    // in a 22px box - so the centred span overflowed its row in both directions and painted over
    // the number underneath it. "29" read as "2".
    const first = fitEventText(Math.floor(128 / 3) - DAY_NUM_H, 12);
    expect(first.fontSize).toBe(12);
    expect(clampLines(first.clampCss)).toBe(1);
    // The slots below it carry no day number, so they keep both lines.
    expect(clampLines(fitEventText(Math.floor(128 / 3), 12).clampCss)).toBe(2);
  });

  it('never asks for more height than the slot has', () => {
    // The whole point of the clamp: whatever it returns must physically fit, at either floor.
    for (const minFont of [9, 12]) {
      for (let availH = 4; availH <= 200; availH++) {
        const { fontSize, clampCss } = fitEventText(availH, minFont);
        const wanted = clampLines(clampCss) * fontSize * EVENT_TITLE_LINE_HEIGHT;
        // One line is the floor and may overflow a slot too short for any text at all; beyond that
        // the fitter must stay inside the box it was given.
        if (clampLines(clampCss) > 1) expect(wanted).toBeLessThanOrEqual(availH);
      }
    }
  });
});
