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

- **P0 - Foundations**: `category` migration + admin control; `poster_project` table + CRUD
  API behind the guard; `/admin` route + dashboard card.
- **P1 - Generator + static render**: "auto-populate" one bubble per asso pre-grouped by
  category; render bubbles + polaroids + themed text directory; PDF export. Presentable map
  with no editing yet.
- **P2 - Editor**: drag / resize / z-index / per-bubble property panel; save & load project.
- **P3 - Polish**: doodle palette, theme presets, free text, background blobs, snap guides.

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
