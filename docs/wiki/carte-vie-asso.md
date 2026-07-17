# Carte de la Vie Asso - Design Doc

Editable poster generator that recreates the hand-made "La carte de la Vie Asso" as a
data-driven, re-editable PDF export. Associations become colored bubbles (logo + color +
president photo + member roster), grouped by theme, laid out on a Canva-style drag & drop
canvas, and rasterised to PDF through the existing snapdom pipeline.

## Goals

- Auto-populate a poster from live association data (name, color, logo, contact, members,
  avatars) so a regenerated map is always up to date.
- Let 1-2 authors (BDE / global admins) hand-arrange bubbles, doodles and free text on a
  canvas, then save the layout as a reusable **project** (re-editable year over year).
- Export a large landscape PDF that matches the on-screen preview exactly (snapdom).

## Access

Gated behind `GlobalAdminOrBdeSuperAdminGuard` (already used for document-reviewers).
The editor lives under `/admin` as a dashboard card.

## Data model

### 1. Thematic category (managed table + one primary category per asso)

Categories are **data, not a hardcoded enum**: a small `association_category` table
(`label`, `slug`, `sortOrder`) editable in admin, so a zone can be added / renamed /
reordered with no migration or deploy. Each association has one primary category
(`categoryId` FK, nullable = uncategorised); the poster editor keeps a per-bubble
`categoryOverride` for visual placement without touching the canonical value.

Rationale: the printed poster places each asso exactly once (one bubble, one directory
line), so a single primary category preserves unambiguous placement. Multi-tag was rejected
because it would duplicate an asso across directory sections and leave its bubble zone
undefined.

Seed (mirrors the printed poster sections):

- `ecole-vie-me` - Ecole, Vie a la Me
- `cuisine` - Cuisine, Decouverte culinaire
- `techno-entrepreneuriat` - Technologies, Entreprenariat
- `culture-arts` - Culture, Arts
- `sport-humain-societe` - Sport, Humain, Societe

Backend: migration creates the table + seeds the 5 rows, adds `categoryId` FK to the
association entity, plus an admin category-manager and a category picker on the association
settings page. The right-hand directory groups by this field.

### 2. Poster project (persisted layout)

One row = one saved map. Content (photos/members) is re-resolved at render time so the
stored project holds layout only, never stale rosters.

```jsonc
{
  "id": "...",
  "name": "Carte 2026",
  "theme": "rentree | dark | minimal",   // preset, mirrors calendarThemes.ts
  "background": { "dataUrl": "...", "scrimOpacity": 0, "pageBg": "#..." },
  "bubbles": [
    {
      "assoId": "...",
      "x": 120, "y": 80, "radius": 90,
      "colorOverride": null,              // else hex
      "categoryOverride": null,           // else category slug
      "president": { "userId": "...", "show": true },
      "polaroids": [{ "userId": "...", "role": "Vice-President" }],
      "rosterRoles": ["Responsable Biere", ...],  // free text lines around the bubble
      "z": 3
    }
  ],
  "doodles": [{ "kind": "kebab|wine|robot|...", "x": 0, "y": 0, "scale": 1, "z": 1 }],
  "texts": [{ "content": "...", "x": 0, "y": 0, "font": "...", "z": 5 }]
}
```

Stored as JSON (table `poster_project`, CRUD API). Consider reusing the document-vault
pattern for storage shape if convenient.

## Rendering & export

The edited canvas **is** the DOM that gets rasterised - no separate export renderer, so
preview and PDF never diverge (the whole point of snapdom, see `pdfRaster.ts` header).

- Canvas = absolutely-positioned `<div>`/SVG layers (no heavy canvas lib), so
  `rasterizeElementToCanvas` captures it directly.
- Bubbles: positioned `<div>`, brand color background, logo + president polaroid, roster
  text lines anchored around the perimeter.
- Right panel: text directory grouped by category, generated from members.
- Export: reuse the trombinoscope/calendar path (snapdom -> canvas -> jsPDF), landscape,
  ~1.4:1, multi-page split if needed.
- Fonts: force-load the Variable families like the other exports.

Avatars come from `/api/users/:id/avatar` (same-origin -> snapdom inlines them). Logos via
`asso.logoUrl`. Fallbacks: `generateAvatarColor` + `getInitials` (same as trombinoscope).

## Phasing

- **P0 - Foundations** (DONE): `category` migration + admin control; `poster_project` table +
  CRUD API behind the guard; `/admin/carte` hub (category manager + poster-project list) +
  dashboard card + nav item; `categoryId` picker in the association profile settings; typed API
  client (`listAssociationCategories`, poster CRUD, ...) + FR/EN i18n. Editor page
  `/admin/carte/[id]` is a stub until P1.
- **P1 - Generator + static render** (DONE, gates green; browser-verify pending):
  auto-populates one bubble per asso pre-grouped by category; renders bubbles + president
  polaroids + a themed text directory; theme picker + background image/scrim; PDF export via
  snapdom. Files: `frontend/src/lib/carte/theme.ts` (3 `CarteTheme` presets colorful/dark/minimal
  + `resolveCarteTheme`), `frontend/src/lib/carte/generator.ts` (`PosterLayout` persisted shape +
  `buildPosterModel` grouping + president detection by role containing "presid"),
  `frontend/src/lib/carte/export.ts` (`exportPosterPdf` = rasterize + jsPDF landscape/paginate),
  `frontend/src/lib/components/carte/PosterCanvas.svelte` (the fixed-1600px DOM that is BOTH the
  preview and the snapdom capture target; initials-behind fallback for broken logo/avatar imgs),
  and the rewritten `/admin/carte/[id]/+page.svelte` (loads project + categories + associations +
  rosters, scaled preview via `transform: scale`, Save persists `{version,theme,background}` into
  `project.layout`, Export PDF). Removed the `carte_editor_coming_soon` i18n key; added the
  `carte_poster_subtitle`/`carte_directory_heading`/`carte_theme_*`/`carte_background_*`/
  `carte_scrim_label`/`carte_save_*`/`carte_export_*`/`carte_zone_uncategorized`/`carte_empty`/
  `carte_settings_heading`/`carte_generated_note` keys (FR+EN). No editing/drag yet (that is P2).
- **P2 - Editor** (DONE, gates green; browser-verify pending): the poster is now a freeform
  absolute canvas. `frontend/src/lib/carte/layout.ts` adds `PositionedBubble` (x/y/scale/z +
  colorOverride/showPresident), `seedBubbleLayout` (auto-grid from the P1 zones), `mergeBubbleLayout`
  (reconciles saved positions with the live model - keeps hand-placed spots, adds new assos, drops
  removed ones), `indexBubbleContent`, and `stageHeight`. `PosterLayout` gained `bubbles?` +
  `directoryVisible?`. `PosterCanvas.svelte` was rewritten into a draggable stage: cards drag (pointer
  events, poster-space delta = client delta / viewScale), resize via 4 corner handles (uniform,
  center-fixed scale), z-index, a selection outline, and click-empty-to-deselect; the directory is a
  toggleable fixed footer. The editor page holds `positioned[]` + `selectedId`, renders a per-bubble
  property panel (color override + reset, president toggle, bring-to-front / send-to-back, reset
  position), persists `layout.bubbles` + `directoryVisible`, and nulls the selection before export so
  the handles are not rasterised. New i18n: `carte_directory_toggle` / `carte_editor_hint` /
  `carte_panel_*` (FR+EN). No migration (layout is an opaque JSON blob).
- **P3a - Free text + decoration layer** (DONE, gates green; browser-verify pending): a generic
  decoration layer sharing the bubble drag/resize machinery. `frontend/src/lib/carte/layout.ts` adds
  `Decoration` (union, currently just `TextDecoration`: id/x/y/scale/z + content/color/bold/align),
  `TEXT_BASE_WIDTH`/`TEXT_BASE_SIZE`, `createTextDecoration`, `sanitizeDecorations` (defensive parse,
  no merge - decorations are not tied to live data), and `stageHeight` now also fits decorations.
  `PosterLayout` gained `decorations?`. `PosterCanvas.svelte` drag was generalized: the `Drag` union
  carries a `target: 'bubble' | 'decoration'` + `baseWidth`, with shared `beginMove`/`beginResize`/
  `emitChange`/`select` helpers routing to the right layer (elements carry a `data-el-root` attr so
  the resize handle + empty-stage deselect find their root). A text decoration renders as an absolute,
  draggable/resizable box (placeholder shown only when `editable` + empty). The editor page holds
  `decorations[]` + `selectedDecorationId`, an "Elements" palette (Add text), and a decoration panel
  (content textarea, color, bold, align left/center/right, front/back, delete); export nulls both
  selections. New i18n `carte_elements_heading`/`carte_add_text`/`carte_text_placeholder`/
  `carte_deco_*`/`carte_align_*` (FR+EN). No migration (layout stays an opaque JSON blob).
- **P3b - Doodle palette** (b36e8b03, gates green; browser-verify pending): a second decoration kind
  (`DoodleDecoration`: kind/shape/color) riding the P3a drag/resize machinery. New module
  `frontend/src/lib/carte/doodles.ts` holds the curated `DOODLE_SHAPES` catalog (12 lucide shapes),
  `doodleIcon(key)` (Star fallback), and `isDoodleShape`; doodles render as inline lucide SVGs so
  they stay self-contained (snapdom-safe) and honour the "lucide only" rule. `layout.ts` adds
  `DOODLE_BASE_SIZE`, `createDoodleDecoration`, and branches `sanitizeDecorations` + `stageHeight` per
  kind. `PosterCanvas.svelte` gained a `{:else if deco.kind === 'doodle'}` branch (scalable/recolorable
  box + 4 corner handles). The editor page adds `addDoodle`, a doodle button grid in the palette, and a
  `selectedTextDeco` narrowed derived so text-only controls (content/bold/align) are gated while
  color/front/back/delete stay common. New i18n `carte_doodles_label` + `carte_doodle_*` (FR+EN). No
  migration (layout stays an opaque JSON blob).
- **P3 remaining - Polish**: theme background blobs, snap guides.

## Reuse map

- `frontend/src/lib/utils/pdfRaster.ts` - rasteriser (as-is).
- `frontend/src/lib/utils/trombinoscope.ts` - bubble/polaroid HTML + jsPDF pattern.
- `frontend/src/lib/utils/calendarExport.ts` + `calendarThemes.ts` - theme presets, scrim,
  block-shadow, multi-page split.
- `frontend/src/lib/associations/api.ts` - `Association` / `AssociationMember` types.

## Open questions / gotchas

- Category taxonomy is fixed above; confirm labels/order with the printed poster before P0.
- Poster projects can grow large (many bubbles + data-URL background) - store background as
  a media reference rather than inline if size becomes an issue.
- The printed poster's charm is hand-placement; the auto-layout in P1 is a starting grid,
  not the final look - the editor (P2) is where it gets its character.
