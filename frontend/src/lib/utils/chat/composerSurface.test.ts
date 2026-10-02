import { describe, expect, it } from 'vitest';
import {
  gifPanelHeight,
  nextComposerSurface,
  panelSpacerPx,
  PANEL_MAX_PX,
  PANEL_MIN_PX,
  SEARCH_STRIP_PX,
  surfaceReservesPanel,
  surfaceTakesBack,
  type ComposerSurface,
  type ComposerSurfaceEvent,
} from './composerSurface';

const ALL: ComposerSurface[] = ['idle', 'menu', 'gif', 'handoff'];

function run(start: ComposerSurface, ...events: ComposerSurfaceEvent[]): ComposerSurface {
  return events.reduce(nextComposerSurface, start);
}

describe('nextComposerSurface - the menu', () => {
  it('opens and closes on its button', () => {
    expect(run('idle', { type: 'menuToggle' })).toBe('menu');
    expect(run('menu', { type: 'menuToggle' })).toBe('idle');
  });

  it.each(['outside', 'escape', 'back'] as const)('closes on %s', (reason) => {
    expect(run('menu', { type: 'dismiss', reason })).toBe('idle');
  });

  it('closes on a pick that leaves for a picker or a modal', () => {
    expect(run('menu', { type: 'pick', target: 'away' })).toBe('idle');
  });

  it('becomes the GIF panel on the GIF entry', () => {
    expect(run('menu', { type: 'pick', target: 'gif' })).toBe('gif');
  });

  it('closes when the keyboard opens, and when the text field takes focus', () => {
    expect(run('menu', { type: 'keyboardOpened' })).toBe('idle');
    expect(run('menu', { type: 'textFocused' })).toBe('idle');
  });

  it('closes on a send', () => {
    expect(run('menu', { type: 'sent' })).toBe('idle');
  });
});

describe('nextComposerSurface - the GIF panel', () => {
  it('hands its room to the keyboard when the text field is tapped, then ends once it is up', () => {
    expect(run('gif', { type: 'textFocused' })).toBe('handoff');
    expect(run('gif', { type: 'textFocused' }, { type: 'keyboardOpened' })).toBe('idle');
  });

  it('ends the hand-off on a blur, when no soft keyboard came', () => {
    expect(run('gif', { type: 'textFocused' }, { type: 'textBlurred' })).toBe('idle');
  });

  it('stays open when its own search field raises the keyboard', () => {
    expect(run('gif', { type: 'keyboardOpened' })).toBe('gif');
  });

  it.each(['outside', 'escape', 'back'] as const)('closes on %s', (reason) => {
    expect(run('gif', { type: 'dismiss', reason })).toBe('idle');
  });

  it('closes on a send - a GIF tapped is sent and the panel goes', () => {
    expect(run('gif', { type: 'sent' })).toBe('idle');
    expect(run('handoff', { type: 'sent' })).toBe('idle');
  });

  it('gives way to the menu', () => {
    expect(run('gif', { type: 'menuToggle' })).toBe('menu');
  });
});

describe('nextComposerSurface - totality', () => {
  it('never leaves the four states, whatever the event', () => {
    const events: ComposerSurfaceEvent[] = [
      { type: 'menuToggle' },
      { type: 'dismiss', reason: 'back' },
      { type: 'pick', target: 'away' },
      { type: 'pick', target: 'gif' },
      { type: 'textFocused' },
      { type: 'textBlurred' },
      { type: 'keyboardOpened' },
      { type: 'sent' },
    ];
    for (const s of ALL) for (const e of events) expect(ALL).toContain(nextComposerSurface(s, e));
  });

  it('idle ignores what only concerns an open surface', () => {
    expect(run('idle', { type: 'textFocused' })).toBe('idle');
    expect(run('idle', { type: 'textBlurred' })).toBe('idle');
    expect(run('idle', { type: 'keyboardOpened' })).toBe('idle');
  });

  it('only the menu and the drawn panel take Back; the panel room is held in gif and handoff', () => {
    expect(ALL.filter(surfaceTakesBack)).toEqual(['menu', 'gif']);
    expect(ALL.filter(surfaceReservesPanel)).toEqual(['gif', 'handoff']);
  });
});

describe('gifPanelHeight', () => {
  it('is the keyboard last measured on this device', () => {
    expect(gifPanelHeight(336, 844)).toBe(336);
  });

  it('is a share of the screen, bounded, before any keyboard was seen', () => {
    expect(gifPanelHeight(null, 844)).toBe(Math.round(844 * 0.4));
    expect(gifPanelHeight(null, 400)).toBe(PANEL_MIN_PX);
    expect(gifPanelHeight(null, 2000)).toBe(PANEL_MAX_PX);
  });
});

describe('panelSpacerPx - the composer does not move', () => {
  const H = 336;

  it('is zero when no panel is reserved', () => {
    expect(
      panelSpacerPx({ reserved: false, panelHeight: H, keyboardOverlap: 0, searchFocused: false })
    ).toBe(0);
  });

  it('keeps composer height + keyboard constant while the keyboard falls under an opening panel', () => {
    for (const overlap of [H, 250, 120, 0]) {
      const spacer = panelSpacerPx({
        reserved: true,
        panelHeight: H,
        keyboardOverlap: overlap,
        searchFocused: false,
      });
      expect(spacer + overlap).toBe(H);
    }
  });

  it('lifts the panel above the keyboard by the search strip while its search is focused', () => {
    expect(
      panelSpacerPx({ reserved: true, panelHeight: H, keyboardOverlap: H, searchFocused: true })
    ).toBe(SEARCH_STRIP_PX);
    // Before the keyboard has risen, the panel keeps its full height - no drop first.
    expect(
      panelSpacerPx({ reserved: true, panelHeight: H, keyboardOverlap: 0, searchFocused: true })
    ).toBe(H);
  });
});
