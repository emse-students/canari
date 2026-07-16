import { DEFAULT_EXPORT_OPTIONS, type CalendarExportOptions } from './calendarExport';
import { m } from '$lib/paraglide/messages';

/**
 * A theme is a full bundle of visual options (everything except the uploaded background image, which
 * stays independent so a user can compose a theme + their own photo - like the hand-made BDE agenda).
 * Selecting a theme overwrites the current options wholesale; the fine-grained pickers in the
 * "Advanced" drawer then let the user tweak from that starting point.
 */
export type CalendarThemeOptions = Required<Omit<CalendarExportOptions, 'bgDataUrl'>>;

export interface CalendarTheme {
  /** Stable id used for selection state. */
  id: string;
  /** Localized display name (function so it re-resolves on locale change). */
  name: () => string;
  /** Complete option set applied when this theme is picked. */
  options: CalendarThemeOptions;
}

/**
 * Curated presets. `rentree` is the closest to the hand-made agenda (full-bleed uploaded photo +
 * dark scrim + white shadowed text + translucent cells); `canari-dark` is a self-contained dark
 * on-brand look that needs no image; `minimal` reproduces the original light default.
 */
export const CALENDAR_THEMES: CalendarTheme[] = [
  {
    id: 'rentree',
    name: () => m.calendar_theme_rentree(),
    options: {
      ...DEFAULT_EXPORT_OPTIONS,
      pageBg: '#12203a',
      headerBg: 'transparent',
      monthTitleColor: '#ffffff',
      weekdayRowBg: 'transparent',
      weekdayLabelColor: '#ffffff',
      weekendLabelColor: '#ffe066',
      weekdayFullNames: true,
      cellBg: '#ffffff',
      cellBgOpacity: 80,
      weekendCellBg: '#eef2f8',
      weekendCellBgOpacity: 72,
      borderColor: 'rgba(255,255,255,0.28)',
      gridOuterBorder: 'rgba(255,255,255,0.35)',
      emptyDayColor: '#2b3a52',
      enableTextShadow: true,
      textShadowColor: '#0b1220',
      textShadowOffset: 2,
      bgOpacity: 100,
      scrimOpacity: 32,
      scrimColor: '#0b1220',
      breakTintOpacity: 22,
    },
  },
  {
    id: 'canari-dark',
    name: () => m.calendar_theme_canari_dark(),
    options: {
      ...DEFAULT_EXPORT_OPTIONS,
      pageBg: '#0f1420',
      headerBg: '#151b2c',
      monthTitleColor: '#f5c518',
      weekdayRowBg: '#0b1120',
      weekdayLabelColor: '#c8d8eb',
      weekendLabelColor: '#f5c518',
      cellBg: '#1b2335',
      cellBgOpacity: 100,
      weekendCellBg: '#161d2c',
      weekendCellBgOpacity: 100,
      borderColor: '#2a3550',
      gridOuterBorder: '#0b1120',
      emptyDayColor: '#5b6b86',
      enableTextShadow: false,
      breakTintOpacity: 20,
    },
  },
  {
    id: 'minimal',
    name: () => m.calendar_theme_minimal(),
    options: { ...DEFAULT_EXPORT_OPTIONS },
  },
];

/** Theme selected on first load: the original light look, to preserve existing behavior. */
export const DEFAULT_THEME_ID = 'minimal';
